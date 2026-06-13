/**
 * Zod v4 schemas for structured Anthropic completions (`completeStructured`).
 *
 * These constrain the model's output shape. Note: structured outputs constrain
 * STRUCTURE (which fields, their JS types) but cannot enforce numeric *bounds* —
 * so the grading caller clamps `quality`/`score` in code (see ai/index.ts).
 */
import { z } from "zod";
import type { QuestionType } from "@tutor/shared";

// --- generateQuestions ----------------------------------------------------

export const questionTypeSchema = z.enum([
  "recall",
  "application",
  "why",
]) satisfies z.ZodType<QuestionType>;

/** A single generated question, before we assign it a stable id + conceptId. */
export const generatedQuestionSchema = z.object({
  type: questionTypeSchema,
  prompt: z.string().min(1).describe("The question text shown to the learner."),
});

export const generatedQuestionsSchema = z.object({
  questions: z
    .array(generatedQuestionSchema)
    .describe("A mix of recall, application, and why questions."),
});

export type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>;
export type GeneratedQuestions = z.infer<typeof generatedQuestionsSchema>;

// --- gradeAnswer ----------------------------------------------------------

/**
 * Grading result shape. Numeric ranges are described for the model but NOT
 * trusted — the caller clamps `quality` to [0,5] and `score` to [0,1].
 */
export const gradeSchema = z.object({
  quality: z
    .number()
    .describe("SM-2 quality, integer 0..5. 0=blank/wrong, 3=barely adequate, 5=perfect."),
  score: z
    .number()
    .describe("Normalized correctness 0..1 for the knowledge-tracing estimate."),
  feedback: z
    .string()
    .min(1)
    .describe("Honest, partial-credit, intuition-first feedback for the learner."),
  whatWasRight: z
    .array(z.string())
    .describe("Specific things the answer got right. Empty only if nothing was right."),
  whatWasMissing: z
    .array(z.string())
    .describe("Specific gaps, errors, or misconceptions in the answer."),
  correctedIntuition: z
    .string()
    .min(1)
    .describe("The correct mental model, stated plainly so it sticks."),
});

export type GradeSchema = z.infer<typeof gradeSchema>;
