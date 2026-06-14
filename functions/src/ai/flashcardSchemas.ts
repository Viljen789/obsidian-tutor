/**
 * Zod v4 schema for the model-written Q/A flashcards (`completeStructured`).
 *
 * Mirrors ai/schemas.ts: the schema constrains STRUCTURE (which fields, their JS
 * types) — it cannot enforce *how many* cards the model returns, so the caller
 * clamps the array length in code (see flows/flashcards.ts). The model proposes
 * only the front/back/hint text; the id, conceptId, and kind are assigned
 * server-side, never trusted from the model.
 */
import { z } from "zod";

/** One model-written Q/A card, before we attach a stable id + conceptId + kind. */
export const generatedFlashcardSchema = z.object({
  front: z
    .string()
    .min(1)
    .describe("The question side — a single, self-contained recall question."),
  back: z
    .string()
    .min(1)
    .describe("The answer side — the concise, correct answer to the question."),
  hint: z
    .string()
    .optional()
    .describe("Optional one-line nudge shown before the answer is revealed."),
});

export const generatedFlashcardsSchema = z.object({
  cards: z
    .array(generatedFlashcardSchema)
    .describe("Short question/answer recall cards grounded in the concept notes."),
});

export type GeneratedFlashcard = z.infer<typeof generatedFlashcardSchema>;
export type GeneratedFlashcards = z.infer<typeof generatedFlashcardsSchema>;
