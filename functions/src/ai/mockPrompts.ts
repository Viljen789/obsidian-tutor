/**
 * Prompt builders + the structured-output schema for the past-exam → mock
 * generator (flows/generateMock.ts).
 *
 * House style mirrors ai/prompts.ts (tight, intuition-aware) and the slot/index
 * mapping mirrors flows/generateExam.ts: the model proposes `{ conceptRef, type,
 * prompt }` per question, where `conceptRef` is a 1-based index into a numbered
 * concept list. We map that index back to a real conceptId in code, so the model
 * can never fabricate an id — and we own the anti-verbatim guardrail here.
 *
 * Why a local schema (and not ai/schemas.ts's generatedQuestionsSchema)? That
 * schema is `{ questions: [{ type, prompt }] }` — no concept mapping. To grade a
 * mock through submitAnswer every question needs a conceptId, so we extend the
 * shape with `conceptRef`. ai/schemas.ts is import-read-only for other flows, so
 * the mock-specific schema lives here.
 */
import { z } from "zod";
import type { Concept } from "@tutor/shared";

/** Keep each concept's context tight so many concepts fit one prompt cheaply. */
const CONTEXT_CHARS = 400;
/**
 * Cap on how much pasted past-exam text we feed the model. A learner might paste
 * a whole paper; we only need enough to infer style, phrasing, and rigor, and we
 * must leave room in the budget for the generated JSON.
 */
const PAST_EXAM_CHARS = 4000;

// The model proposes one question per slot. `conceptRef` is the 1-based index
// into the numbered concept list we hand it — more reliable than echoing a slug
// id or a free-text title. We clamp it into range and fall back to round-robin
// server-side, so an out-of-range or missing ref never ships a bad conceptId.
export const mockQuestionSchema = z.object({
  conceptRef: z
    .number()
    .describe("1-based index of the concept this question tests, from the numbered concept list."),
  type: z
    .enum(["recall", "application", "why"])
    .describe("recall = retrieve a fact/definition; application = apply it; why = reasoning/trade-off."),
  prompt: z
    .string()
    .min(1)
    .describe("The NEW question text shown to the learner. Self-contained, free-text, no answer, no numbering."),
});

export const mockSchema = z.object({
  questions: z
    .array(mockQuestionSchema)
    .describe("Fresh questions in the past paper's style, spread across the numbered concepts."),
});

export type MockQuestion = z.infer<typeof mockQuestionSchema>;
export type MockResult = z.infer<typeof mockSchema>;

/**
 * System prompt. The CRITICAL guardrail lives here: produce NEW questions that
 * match the SHAPE, phrasing conventions, and difficulty of the pasted paper —
 * never reproduce any pasted question verbatim or near-verbatim, and never just
 * swap a number or a noun. Coverage is steered toward the learner's own concepts
 * so every question maps to one (and therefore grades through submitAnswer).
 */
export function mockSystemPrompt(subject: string, count: number): string {
  return [
    `You are an examiner writing a fresh MOCK exam for the subject "${subject}".`,
    `Produce EXACTLY ${count} short-answer questions, spread across the numbered concepts below.`,
    "",
    "STUDY the pasted past-exam questions to infer their STYLE only: phrasing conventions,",
    "command words (e.g. \"Define\", \"Explain why\", \"Given ... compute\"), structure, and difficulty/rigor.",
    "Then write BRAND-NEW questions in that same shape and at that same level.",
    "",
    "CRITICAL anti-copying rules:",
    "  - NEVER reproduce any pasted question verbatim or near-verbatim.",
    "  - Do NOT merely swap a number, name, or single noun in a pasted question — that is copying.",
    "  - Each question must test the learner's concepts (below), NOT necessarily the exact",
    "    topics in the pasted paper. Match the past paper's STYLE, not its content.",
    "",
    "Map every question to a concept: set `conceptRef` to that concept's number from the list.",
    "Spread coverage across the concepts and mix the three question types overall",
    "(roughly balance recall / application / why; don't make them all one type):",
    '  - "recall": retrieve a key fact, definition, or property.',
    '  - "application": apply the idea to a concrete new situation, example, or mini-problem.',
    '  - "why": explain the reasoning, cause, trade-off, or consequence behind it.',
    "Every question must be answerable from that concept's notes, free-text (NOT multiple-choice),",
    "self-contained, and exam-appropriate. No answers, no hints, no concept numbers in the prompt text.",
  ].join("\n");
}

/**
 * User prompt. Hands the model (1) the numbered concept list with tight context,
 * and (2) the pasted past-exam text as a clearly-fenced STYLE REFERENCE — framed
 * so the model treats it as a style/difficulty sample to mimic, not a bank to
 * copy from.
 */
export function mockUserPrompt(args: {
  subject: string;
  concepts: Concept[];
  pastExamText: string;
  count: number;
}): string {
  const conceptLines = args.concepts.map((c, i) => {
    const context = c.bodyMarkdown.trim().slice(0, CONTEXT_CHARS).replace(/\s+/g, " ");
    return [
      `${i + 1}. "${c.title}"`,
      context ? `   notes: ${context}` : "   notes: (none — use the concept title)",
    ].join("\n");
  });

  const pastExam = args.pastExamText.trim().slice(0, PAST_EXAM_CHARS);

  return [
    `Concepts in "${args.subject}" (write questions ONLY about these; the number is the conceptRef):`,
    "",
    ...conceptLines,
    "",
    "Past-exam questions — STYLE REFERENCE ONLY. Mimic their shape, phrasing, and difficulty.",
    "Do NOT reuse their wording or copy any question:",
    "---",
    pastExam,
    "---",
    "",
    `Now write ${args.count} brand-new questions in that style, spread across the numbered concepts.`,
  ].join("\n");
}
