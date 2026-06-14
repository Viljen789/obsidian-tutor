/**
 * ingestPdf flow.
 *
 * The learner uploads a lecture PDF / slide deck to Cloud Storage, then calls
 * api.ingestPdf({ storagePath }). We download the file, hand the raw bytes to
 * Gemini (multimodal — `completeStructuredWithFile`), and ask for a structured
 * concept outline `[{ title, subject, body }]`. Each concept becomes a
 * ParsedNote (with a synthesised `Lectures/<title>.md` sourcePath) and flows
 * through the SAME idempotent ingest pipeline as a vault import
 * (`ingestParsedNotes` → graph assembly → prereq inference → upsert; mastery is
 * never touched). The number of concepts is capped (MAX_PDF_CONCEPTS) and the
 * output budget bounded (TOKEN_CAPS.pdf) so a big deck can't truncate the JSON.
 */
import { getStorage } from "firebase-admin/storage";
import type { IngestPdfRequest, IngestPdfResponse } from "@tutor/shared";
import { TOKEN_CAPS } from "../config";
import { authedCallable, HttpsError } from "../lib/callable";
import { MODELS, completeStructuredWithFile, llmSecrets } from "../lib/llm";
import { ingestParsedNotes, type ParsedNote } from "../ingest/index";
import {
  MAX_PDF_CONCEPTS,
  pdfOutlineSchema,
  pdfSystemPrompt,
  pdfUserPrompt,
} from "../ai/pdfPrompts";

/** Filesystem-safe note basename derived from a concept title. */
function safeTitle(title: string): string {
  return (
    title
      .trim()
      .replace(/[/\\:*?"<>|]+/g, " ") // strip path-hostile chars
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "Untitled"
  );
}

export const ingestPdf = authedCallable<IngestPdfRequest, IngestPdfResponse>(
  { secrets: llmSecrets },
  async ({ storagePath }, { uid }): Promise<IngestPdfResponse> => {
    // 1. Validate + download the uploaded PDF from Cloud Storage.
    if (!storagePath || typeof storagePath !== "string") {
      throw new HttpsError("invalid-argument", "storagePath is required.");
    }

    let base64: string;
    try {
      const [buf] = await getStorage().bucket().file(storagePath).download();
      base64 = buf.toString("base64");
    } catch (err) {
      throw new HttpsError(
        "not-found",
        `Could not download the PDF at ${storagePath}: ${(err as Error).message}`,
      );
    }

    // 2. Gemini (multimodal) reads the file and returns a structured concept
    //    outline. The token cap keeps the JSON from truncating on a big deck.
    let outline;
    try {
      outline = await completeStructuredWithFile({
        model: MODELS.teach,
        system: pdfSystemPrompt(),
        prompt: pdfUserPrompt(),
        maxTokens: TOKEN_CAPS.pdf,
        schema: pdfOutlineSchema,
        file: { mimeType: "application/pdf", base64 },
      });
    } catch (err) {
      throw new HttpsError(
        "internal",
        `Couldn't read concepts from that PDF: ${(err as Error).message}`,
      );
    }

    // 3. Map concepts → ParsedNotes. Cap the count, drop empties, de-dupe by
    //    title (case-insensitive) so the same concept can't be ingested twice.
    const seen = new Set<string>();
    const notes: ParsedNote[] = [];
    for (const c of outline.concepts ?? []) {
      const title = (c.title ?? "").trim();
      const subject = (c.subject ?? "").trim();
      const body = (c.body ?? "").trim();
      if (!title || !body) continue;

      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      notes.push({
        sourcePath: `Lectures/${safeTitle(title)}.md`,
        title,
        subject: subject || "Lecture",
        tags: [],
        bodyMarkdown: body,
        wikilinks: [],
        frontmatter: {},
        imageEmbeds: [],
      });

      if (notes.length >= MAX_PDF_CONCEPTS) break;
    }

    if (notes.length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "Couldn't find concepts in that PDF. Make sure it's a lecture or slide deck with readable text.",
      );
    }

    // 4. Same idempotent pipeline as a vault import: graph assembly → prereq
    //    inference → upsert. Mastery is preserved.
    return ingestParsedNotes(uid, notes);
  },
);
