/**
 * PDF lecture extraction — schema + prompts.
 *
 * Gemini (multimodal) reads an uploaded lecture PDF / slide deck and returns a
 * structured concept outline: an array of `{ title, subject, body }`. Those map
 * 1:1 onto ParsedNote-shaped objects that flow through the SAME ingest pipeline
 * as an Obsidian vault (graph assembly → prereq inference → idempotent upsert).
 *
 * Structured output can't enforce array length, so the prompt asks for a sane
 * number of concepts and the flow clamps to MAX_PDF_CONCEPTS — both to keep the
 * JSON from truncating under TOKEN_CAPS.pdf and to keep the import focused.
 */
import { z } from "zod";

/**
 * Hard ceiling on extracted concepts. The prompt requests a sensible count; the
 * flow slices to this so a large deck can't blow the output budget and truncate
 * the JSON mid-object.
 */
export const MAX_PDF_CONCEPTS = 20;

/**
 * One extracted concept from the lecture. `body` is a tight, intuition-first
 * markdown summary grounded in the PDF — enough to teach the idea and to seed
 * question generation. `subject` is the lecture/course name, repeated identically
 * across every concept so they group under one subject.
 */
export const pdfConceptSchema = z.object({
  title: z.string().describe("Short, specific name of the concept (a few words)."),
  subject: z
    .string()
    .describe(
      "The lecture or course name — IDENTICAL across every concept in this outline.",
    ),
  body: z
    .string()
    .describe(
      "Tight intuition-first markdown summary of this concept, grounded in the PDF: a few sentences to a short paragraph — enough to teach it and write questions about it.",
    ),
});

/** The model's full reply: the concept outline extracted from the lecture. */
export const pdfOutlineSchema = z.object({
  concepts: z
    .array(pdfConceptSchema)
    .describe(
      `The concept outline for this lecture (aim for a sensible number, at most ${MAX_PDF_CONCEPTS}).`,
    ),
});

export type PdfOutline = z.infer<typeof pdfOutlineSchema>;

/** System prompt: frame the model as a careful curriculum extractor. */
export function pdfSystemPrompt(): string {
  return [
    "You extract a clean concept outline from a lecture PDF or slide deck so it can be taught.",
    "You are given the actual file — read it directly.",
    "",
    "Rules:",
    "- Identify the distinct teachable concepts the lecture covers, in the order they appear.",
    `- Return a sensible number of concepts — at most ${MAX_PDF_CONCEPTS}. Merge trivially small points; split genuinely separate ideas.`,
    "- For each concept write an intuition-first body in markdown: lead with the core idea in plain language, then the key detail. A few sentences to a short paragraph — enough to teach it and to generate questions, no filler.",
    "- Ground EVERYTHING in the document. Do not invent facts, examples, or concepts that aren't in the lecture.",
    "- Use the lecture's / course's own name as `subject`, and use that SAME subject string for every concept.",
    "- Skip title slides, agendas, references, and thank-you slides — only real concepts.",
  ].join("\n");
}

/**
 * User prompt. The PDF bytes are attached separately by the caller (via
 * completeStructuredWithFile); this is the accompanying instruction.
 */
export function pdfUserPrompt(): string {
  return [
    "Read the attached lecture PDF and extract its concept outline.",
    "",
    "Return JSON matching the schema: an array of concepts, each with:",
    "- title: a short, specific name for the concept",
    "- subject: the lecture/course name (the SAME string for every concept)",
    "- body: a tight, intuition-first markdown summary of that concept, drawn from the lecture",
    "",
    `Produce a sensible number of concepts (at most ${MAX_PDF_CONCEPTS}), grounded entirely in the document.`,
  ].join("\n");
}
