/**
 * Prompt builders + the structured-output schema for the cross-concept
 * SYNTHESIS generator (flows/synthesis.ts).
 *
 * House style mirrors ai/prompts.ts (tight, intuition-aware) and the slot/index
 * mapping mirrors ai/mockPrompts.ts: the model proposes `{ conceptRefs, type,
 * prompt }` per question, where each entry of `conceptRefs` is a 1-based index
 * into a numbered concept list. We map those indices back to real conceptIds in
 * code, so the model can never fabricate an id — and we own the guardrail that
 * every shipped question still integrates >= 2 distinct, valid concepts.
 *
 * Why a local schema (and not ai/schemas.ts)? Synthesis is the one generator
 * whose questions span MULTIPLE concepts, so each carries `conceptRefs: number[]`
 * (>= 2) rather than a single ref. ai/schemas.ts is import-read-only for other
 * flows, so the synthesis-specific shape lives here.
 */
import { z } from "zod";
import type { Concept } from "@tutor/shared";

/** Keep each concept's context tight so many concepts fit one prompt cheaply. */
const CONTEXT_CHARS = 360;

// The model proposes one integration question per slot. `conceptRefs` lists the
// 1-based indices (into the numbered concept list) that the question weaves
// together — more reliable than echoing slug ids or free-text titles. We clamp,
// de-dupe, drop out-of-range refs, and fall back to adjacent pairing in code, so
// a bad set of refs never ships a question that integrates fewer than 2 concepts.
export const synthesisQuestionSchema = z.object({
  conceptRefs: z
    .array(z.number())
    .describe(
      "1-based indices (from the numbered concept list) of the 2–3 concepts this question weaves together.",
    ),
  type: z
    .enum(["recall", "application", "why"])
    .describe(
      "recall = connect/contrast facts across the concepts; application = apply them together to a scenario; why = reason about how they interact.",
    ),
  prompt: z
    .string()
    .min(1)
    .describe(
      "The integration question shown to the learner. Self-contained, free-text, weaves the referenced concepts together. No answer, no numbering.",
    ),
});

export const synthesisSchema = z.object({
  questions: z
    .array(synthesisQuestionSchema)
    .describe(
      "Cross-concept integration questions, each weaving 2–3 of the numbered concepts together.",
    ),
});

export type SynthesisGenQuestion = z.infer<typeof synthesisQuestionSchema>;
export type SynthesisGenResult = z.infer<typeof synthesisSchema>;

/**
 * System prompt. The defining instruction: every question must genuinely
 * INTEGRATE two or three of the numbered concepts — the kind of exam question
 * that can't be answered from a single concept's notes alone. Single-concept
 * questions are explicitly disallowed.
 */
export function synthesisSystemPrompt(subject: string, count: number): string {
  return [
    `You are an examiner writing CROSS-CONCEPT integration questions for the subject "${subject}".`,
    `Produce EXACTLY ${count} questions. EACH question must weave TOGETHER 2–3 of the numbered concepts below`,
    "— the kind of synthesis question that cannot be answered from any single concept's notes alone.",
    "",
    "CRITICAL integration rules:",
    "  - Every question MUST reference at least TWO distinct concepts via `conceptRefs` (their numbers).",
    "  - The question must require the learner to relate, contrast, combine, or trace cause-and-effect",
    "    ACROSS those concepts — not just recite one of them with the other named in passing.",
    "  - Prefer pairs/triples that genuinely connect; don't force unrelated concepts together.",
    "",
    "Set `conceptRefs` to the numbers of the concepts each question integrates, and mix the three types",
    "overall (roughly balance them; don't make them all one type):",
    '  - "recall": connect or contrast key facts/definitions across the concepts.',
    '  - "application": apply the combined ideas to one concrete new scenario or problem.',
    '  - "why": reason about how the concepts interact, depend on, or trade off against each other.',
    "Every question must be answerable from the referenced concepts' notes, free-text (NOT multiple-choice),",
    "self-contained, and exam-appropriate. No answers, no hints, no concept numbers in the prompt text.",
  ].join("\n");
}

/**
 * User prompt. Hands the model the numbered concept list with tight context;
 * each number is the value to use in `conceptRefs`.
 */
export function synthesisUserPrompt(args: {
  subject: string;
  concepts: Concept[];
  count: number;
}): string {
  const conceptLines = args.concepts.map((c, i) => {
    const context = c.bodyMarkdown.trim().slice(0, CONTEXT_CHARS).replace(/\s+/g, " ");
    return [
      `${i + 1}. "${c.title}"`,
      context ? `   notes: ${context}` : "   notes: (none — use the concept title)",
    ].join("\n");
  });

  return [
    `Concepts in "${args.subject}" (the number before each is its conceptRef):`,
    "",
    ...conceptLines,
    "",
    `Now write ${args.count} integration questions, each weaving together 2–3 of the numbered concepts.`,
    "Reference the concepts each question uses by their numbers in `conceptRefs` (at least two per question).",
  ].join("\n");
}
