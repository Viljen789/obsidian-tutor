/**
 * generateCheatSheet — distil a whole subject into ONE dense, print-friendly
 * exam-day revision sheet (key definitions, formulas, facts) as Markdown.
 *
 * Shape (mirrors explainConcept's cache discipline + generateExam's concept
 * loading): cache-check first so a repeat request never re-spends a model call;
 * on a miss, load the subject's concepts, condense their titles + trimmed bodies
 * into a single TIGHT one-page sheet via one completeText call, then cache it
 * per subject (keyed by encodeURIComponent(subject)) and return it.
 *
 * Cost guardrails honored: the active LLM secret is bound, the cache is checked
 * before spending, the call obeys TOKEN_CAPS.cheatsheet, and each concept's body
 * is trimmed (CHEATSHEET_CONTEXT_CHARS) so many concepts fit the budget.
 */
import type {
  CheatSheetEntry,
  GenerateCheatSheetRequest,
  GenerateCheatSheetResponse,
} from "@tutor/shared";
import { TOKEN_CAPS } from "../config";
import { authedCallable, HttpsError } from "../lib/callable";
import { MODELS, completeText, llmSecrets } from "../lib/llm";
import { getCheatSheet, listConcepts, setCheatSheet } from "../lib/firebase";
import {
  cheatSheetSystemPrompt,
  cheatSheetUserPrompt,
} from "../ai/cheatsheetPrompts";

export const generateCheatSheet = authedCallable<
  GenerateCheatSheetRequest,
  GenerateCheatSheetResponse
>({ secrets: llmSecrets }, async (data, { uid }): Promise<GenerateCheatSheetResponse> => {
  const subject = (data.subject ?? "").trim();
  if (!subject) {
    throw new HttpsError("invalid-argument", "A cheat sheet needs a subject.");
  }

  // The cache is keyed by the encoded subject string (one cached sheet per subject).
  const key = encodeURIComponent(subject);

  // Cost guardrail: serve from cache before spending a model call.
  const cached = await getCheatSheet(uid, key);
  if (cached) {
    return { subject, markdown: cached.markdown, model: cached.model, cached: true };
  }

  const concepts = await listConcepts(uid, subject);
  if (concepts.length === 0) {
    throw new HttpsError(
      "not-found",
      `No concepts found for "${subject}". Import a vault with this subject first.`,
    );
  }

  const raw = await completeText({
    model: MODELS.teach,
    system: cheatSheetSystemPrompt(subject),
    prompt: cheatSheetUserPrompt({
      subject,
      concepts: concepts.map((c) => ({ title: c.title, bodyMarkdown: c.bodyMarkdown })),
    }),
    maxTokens: TOKEN_CAPS.cheatsheet,
  });

  // Gemini sometimes wraps "produce markdown" output in a ```markdown fence —
  // strip it so the client renders the sheet, not a literal code block.
  const markdown = raw
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  const entry: CheatSheetEntry = {
    subject,
    markdown,
    model: MODELS.teach,
    createdAt: new Date().toISOString(),
  };
  await setCheatSheet(uid, key, entry);

  return { subject, markdown, model: MODELS.teach, cached: false };
});
