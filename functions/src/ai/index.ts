/**
 * AI-in-the-loop callables (Phase 2).
 *
 * All four call the active LLM provider via the lib/llm helpers (never an SDK
 * directly). `gradeAnswer` is a plain helper, not a callable, because the
 * `submitAnswer` flow composes it with the engine's mastery update.
 *
 * Guardrails honored here:
 *   - the Anthropic secret is bound on every callable,
 *   - explainConcept checks the cache before spending a model call,
 *   - every call obeys its TOKEN_CAPS budget,
 *   - structured grading is clamped to its numeric bounds in code.
 */
import type {
  ExplainConceptRequest,
  ExplainConceptResponse,
  ExplanationCacheEntry,
  GenerateQuestionsRequest,
  GenerateQuestionsResponse,
  GradeResult,
  Question,
  RequestHintRequest,
  RequestHintResponse,
} from "@tutor/shared";
import { DEFAULTS, TOKEN_CAPS } from "../config";
import { authedCallable, HttpsError } from "../lib/callable";
import { MODELS, completeStructured, completeText, llmSecrets } from "../lib/llm";
import {
  getConcept,
  getExplanationCache,
  setExplanationCache,
} from "../lib/firebase";
import {
  explainSystemPrompt,
  explainUserPrompt,
  gradeSystemPrompt,
  gradeUserPrompt,
  hintSystemPrompt,
  hintUserPrompt,
  questionsSystemPrompt,
  questionsUserPrompt,
} from "./prompts";
import { gradeSchema, generatedQuestionsSchema } from "./schemas";

/** Clamp a number into [min, max]; falls back to `min` for NaN/non-finite. */
function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

// --- explainConcept -------------------------------------------------------
// Intuition-first explanation. Checks explanationCache first (cost guardrail);
// only calls the model on a miss, then caches the result.
export const explainConcept = authedCallable<ExplainConceptRequest, ExplainConceptResponse>(
  { secrets: llmSecrets },
  async (data, { uid }): Promise<ExplainConceptResponse> => {
    const depth = data.depth ?? "standard";

    const concept = await getConcept(uid, data.conceptId);
    if (!concept) {
      throw new HttpsError("not-found", `Concept not found: ${data.conceptId}`);
    }

    // Cost guardrail: serve from cache before spending a model call.
    const cached = await getExplanationCache(uid, data.conceptId, depth);
    if (cached) {
      return {
        conceptId: data.conceptId,
        depth,
        markdown: cached.markdown,
        model: cached.model,
        cached: true,
      };
    }

    const markdown = await completeText({
      model: MODELS.teach,
      system: explainSystemPrompt(depth),
      prompt: explainUserPrompt({
        title: concept.title,
        subject: concept.subject,
        bodyMarkdown: concept.bodyMarkdown,
      }),
      maxTokens: TOKEN_CAPS.explain,
    });

    const entry: ExplanationCacheEntry = {
      conceptId: data.conceptId,
      depth,
      markdown,
      model: MODELS.teach,
      createdAt: new Date().toISOString(),
    };
    await setExplanationCache(uid, entry);

    return {
      conceptId: data.conceptId,
      depth,
      markdown,
      model: MODELS.teach,
      cached: false,
    };
  },
);

// --- generateQuestions ----------------------------------------------------
// Structured output → a mix of recall / application / why questions. We assign
// stable ids + the conceptId server-side (the model only proposes type + prompt).
export const generateQuestions = authedCallable<
  GenerateQuestionsRequest,
  GenerateQuestionsResponse
>({ secrets: llmSecrets }, async (data, { uid }): Promise<GenerateQuestionsResponse> => {
  const count = data.count ?? DEFAULTS.questionCount;

  const concept = await getConcept(uid, data.conceptId);
  if (!concept) {
    throw new HttpsError("not-found", `Concept not found: ${data.conceptId}`);
  }

  const result = await completeStructured({
    model: MODELS.teach,
    system: questionsSystemPrompt(count),
    prompt: questionsUserPrompt({
      title: concept.title,
      subject: concept.subject,
      bodyMarkdown: concept.bodyMarkdown,
      count,
    }),
    maxTokens: TOKEN_CAPS.questions,
    schema: generatedQuestionsSchema,
  });

  const questions: Question[] = result.questions.map((q, i) => ({
    id: `${data.conceptId}_q${i + 1}`,
    conceptId: data.conceptId,
    type: q.type,
    prompt: q.prompt,
  }));

  return {
    conceptId: data.conceptId,
    questions,
    model: MODELS.teach,
  };
});

// --- requestHint ----------------------------------------------------------
// A nudge toward the answer — explicitly NOT the full answer.
export const requestHint = authedCallable<RequestHintRequest, RequestHintResponse>(
  { secrets: llmSecrets },
  async (data, { uid }): Promise<RequestHintResponse> => {
    const concept = await getConcept(uid, data.conceptId);
    if (!concept) {
      throw new HttpsError("not-found", `Concept not found: ${data.conceptId}`);
    }

    const hint = await completeText({
      model: MODELS.teach,
      system: hintSystemPrompt(),
      prompt: hintUserPrompt({
        conceptTitle: concept.title,
        question: data.question,
        partialAnswer: data.partialAnswer,
      }),
      maxTokens: TOKEN_CAPS.hint,
    });

    return { hint, model: MODELS.teach };
  },
);

// --- gradeAnswer (helper, used by the submitAnswer flow) ------------------
export interface GradeAnswerArgs {
  question: string;
  answer: string;
  conceptTitle: string;
  conceptContext: string; // the concept body / key points for grounding
}

/**
 * Honest, partial-credit grading. Returns a GradeResult-shaped object.
 * Structured outputs cannot enforce numeric bounds, so we clamp `quality` to
 * [0,5] (and round to an integer for SM-2) and `score` to [0,1] here.
 */
export async function gradeAnswer(args: GradeAnswerArgs): Promise<GradeResult> {
  const graded = await completeStructured({
    model: MODELS.grade,
    system: gradeSystemPrompt(),
    prompt: gradeUserPrompt({
      conceptTitle: args.conceptTitle,
      conceptContext: args.conceptContext,
      question: args.question,
      answer: args.answer,
    }),
    maxTokens: TOKEN_CAPS.grade,
    schema: gradeSchema,
  });

  return {
    quality: Math.round(clamp(graded.quality, 0, 5)),
    score: clamp(graded.score, 0, 1),
    feedback: graded.feedback,
    whatWasRight: graded.whatWasRight,
    whatWasMissing: graded.whatWasMissing,
    correctedIntuition: graded.correctedIntuition,
    model: MODELS.grade,
  };
}
