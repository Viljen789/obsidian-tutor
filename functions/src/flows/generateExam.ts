/**
 * generateExam — builds a practice exam across a subject's concepts (a mix of
 * recall / application / why). Each question carries its conceptId so answers
 * can be graded via submitAnswer (an exam doubles as spaced review).
 *
 * Shape: load the subject's concepts, pick a spread of up to `count` of them,
 * then make ONE structured LLM call that proposes a question per "slot" (a slot
 * is a chosen concept; to reach `count` when few concepts exist, some concepts
 * own two slots). The model only proposes { conceptRef, type, prompt }; we own
 * the conceptId mapping and the stable ids, so the model can't fabricate either.
 */
import type {
  Concept,
  GenerateExamRequest,
  GenerateExamResponse,
  Question,
} from "@tutor/shared";
import { z } from "zod";
import { authedCallable, HttpsError } from "../lib/callable";
import { MODELS, completeStructured, llmSecrets } from "../lib/llm";
import { listConcepts } from "../lib/firebase";

/** Default exam length when the caller doesn't ask for a specific count. */
const DEFAULT_EXAM_COUNT = 10;
/** Clamp on caller-supplied count so a huge `count` can't blow the token budget. */
const MAX_EXAM_COUNT = 20;
/**
 * Output-token cap for the whole exam. Sized generously (well above the per-
 * concept `questions` cap) so the JSON for ~10 questions never truncates —
 * Flash's "thinking" is already disabled in the Gemini helper, so the full
 * budget goes to the JSON itself.
 */
const EXAM_MAX_TOKENS = 2500;
/** Keep each concept's context tight so many concepts fit one prompt cheaply. */
const CONTEXT_CHARS = 600;

// The model proposes a question per slot. `conceptRef` is the 1-based index into
// the numbered concept list we hand it — far more reliable than asking it to
// echo a slug id. We map it back to a real conceptId in code (and clamp it).
const examQuestionSchema = z.object({
  conceptRef: z
    .number()
    .describe("1-based index of the concept this question tests, from the numbered list."),
  type: z
    .enum(["recall", "application", "why"])
    .describe("recall = retrieve a fact/definition; application = apply it; why = reasoning/trade-off."),
  prompt: z.string().min(1).describe("The question text shown to the learner. Self-contained, free-text, no answer."),
});

const examSchema = z.object({
  questions: z
    .array(examQuestionSchema)
    .describe("One question per requested slot, spread across the concepts, mixing the three types."),
});

/**
 * Choose which concepts to examine and in what order. We want breadth first:
 * one question per distinct concept, in a stable shuffled order, then — only if
 * `count` exceeds the number of concepts — wrap around to give some concepts a
 * second question. Returns one entry per question slot.
 */
function pickSlots(concepts: Concept[], count: number): Concept[] {
  const pool = shuffle(concepts); // non-empty: callers guard concepts.length > 0
  const slots: Concept[] = [];
  for (let i = 0; i < count; i++) {
    const c = pool[i % pool.length];
    if (c) slots.push(c);
  }
  return slots;
}

/** Fisher–Yates shuffle (Math.random is fine for a cosmetic question spread). */
function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

function buildPrompt(slots: Concept[], subject: string): { system: string; prompt: string } {
  const system = [
    `You are writing a practice EXAM for the subject "${subject}".`,
    `Produce EXACTLY ${slots.length} short-answer questions — one per numbered slot below, in order.`,
    "Each slot names the concept that question must test; set `conceptRef` to that slot's number.",
    "Spread the exam across the concepts and cover a MIX of the three types overall",
    "(roughly balance recall / application / why; don't make them all one type):",
    '  - "recall": retrieve a key fact, definition, or property.',
    '  - "application": apply the idea to a concrete new situation, example, or mini-problem.',
    '  - "why": explain the reasoning, cause, trade-off, or consequence behind it.',
    "Each question must be answerable from that concept's notes, free-text (NOT multiple-choice),",
    "self-contained, and exam-appropriate in difficulty. No answers, no hints, no slot numbers in the prompt text.",
  ].join("\n");

  const lines = slots.map((c, i) => {
    const context = c.bodyMarkdown.trim().slice(0, CONTEXT_CHARS);
    return [
      `Slot ${i + 1} — concept: "${c.title}"`,
      context ? `  notes: ${context.replace(/\s+/g, " ")}` : "  notes: (none — use the concept title)",
    ].join("\n");
  });

  const prompt = [
    `Write one question for each of these ${slots.length} slots:`,
    "",
    ...lines,
    "",
    `Return ${slots.length} questions, in slot order.`,
  ].join("\n");

  return { system, prompt };
}

export const generateExam = authedCallable<GenerateExamRequest, GenerateExamResponse>(
  { secrets: llmSecrets },
  async (data, { uid }): Promise<GenerateExamResponse> => {
    const subject = (data.subject ?? "").trim();
    if (!subject) {
      throw new HttpsError("invalid-argument", "An exam needs a subject.");
    }

    const concepts = await listConcepts(uid, subject);
    if (concepts.length === 0) {
      throw new HttpsError(
        "failed-precondition",
        `No concepts found for "${subject}". Import a vault with this subject first.`,
      );
    }

    const requested = data.count ?? DEFAULT_EXAM_COUNT;
    const count = Math.max(1, Math.min(MAX_EXAM_COUNT, Math.floor(requested)));
    const slots = pickSlots(concepts, count);

    const { system, prompt } = buildPrompt(slots, subject);
    const result = await completeStructured({
      model: MODELS.teach,
      system,
      prompt,
      maxTokens: EXAM_MAX_TOKENS,
      schema: examSchema,
    });

    // Map each generated question back to a real conceptId. We trust the model's
    // `conceptRef` only as a hint and clamp it into range; if the model returns
    // fewer questions than slots, we fall back to the slot's own concept so the
    // exam never ships a question without a valid conceptId.
    const questions: Question[] = slots.map((slotConcept, i) => {
      const generated = result.questions[i];
      const ref = generated ? Math.round(generated.conceptRef) - 1 : i;
      const concept = slots[ref] ?? slotConcept;
      return {
        id: `exam_${i + 1}`,
        conceptId: concept.id,
        type: generated?.type ?? "recall",
        prompt: generated?.prompt?.trim() || `Explain a key idea from "${concept.title}".`,
      };
    });

    return { subject, questions, model: MODELS.teach };
  },
);
