/**
 * critiqueExplanation flow — Feynman "explain it back".
 *
 * The learner explains a concept in their own words (teaching-to-learn); we
 * critique the EXPLANATION itself — what's right, what's missing/wrong, plus a
 * refined version to study — rather than grading an answer to a question.
 *
 * Shape mirrors ai/index.ts gradeAnswer: load the concept for grounding, call
 * completeStructured (MODELS.grade, TOKEN_CAPS.critique) with the Feynman rubric,
 * then clamp the model's `score` to [0,1] in code (structured outputs constrain
 * shape, not numeric bounds).
 */
import type {
  CritiqueExplanationRequest,
  CritiqueExplanationResponse,
} from "@tutor/shared";
import { TOKEN_CAPS } from "../config";
import { authedCallable, HttpsError } from "../lib/callable";
import { MODELS, completeStructured, llmSecrets } from "../lib/llm";
import { getConcept } from "../lib/firebase";
import {
  critiqueSchema,
  critiqueSystemPrompt,
  critiqueUserPrompt,
} from "../ai/feynmanPrompts";

/** Minimum explanation length we'll bother critiquing (chars, after trim). */
const MIN_EXPLANATION_LENGTH = 10;

/** Clamp a number into [min, max]; falls back to `min` for NaN/non-finite. */
function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export const critiqueExplanation = authedCallable<
  CritiqueExplanationRequest,
  CritiqueExplanationResponse
>({ secrets: llmSecrets }, async (data, { uid }): Promise<CritiqueExplanationResponse> => {
  const conceptId = data.conceptId?.trim();
  const explanation = data.explanation?.trim() ?? "";

  if (!conceptId) {
    throw new HttpsError("invalid-argument", "A conceptId is required.");
  }
  if (explanation.length < MIN_EXPLANATION_LENGTH) {
    throw new HttpsError(
      "invalid-argument",
      "Write a bit more — explain the concept in your own words first.",
    );
  }

  const concept = await getConcept(uid, conceptId);
  if (!concept) {
    throw new HttpsError("not-found", `Concept not found: ${conceptId}`);
  }

  const critique = await completeStructured({
    model: MODELS.grade,
    system: critiqueSystemPrompt(),
    prompt: critiqueUserPrompt({
      title: concept.title,
      subject: concept.subject,
      bodyMarkdown: concept.bodyMarkdown,
      explanation,
    }),
    maxTokens: TOKEN_CAPS.critique,
    schema: critiqueSchema,
  });

  return {
    score: clamp(critique.score, 0, 1),
    feedback: critique.feedback,
    whatWasRight: critique.whatWasRight,
    whatWasMissing: critique.whatWasMissing,
    refinedExplanation: critique.refinedExplanation,
    model: MODELS.grade,
  };
});
