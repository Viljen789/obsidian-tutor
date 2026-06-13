/**
 * Cloud Function request/response contracts.
 *
 * Every endpoint is a Firebase *callable* function (`onCall`) — auth context is
 * implicit, so no request carries a `uid`. All grading, spaced-repetition math,
 * and sequencing happen server-side and are never client-trusted.
 *
 * `CALLABLE` is the single registry of function names so the client and the
 * backend cannot drift apart.
 */

import type {
  Concept,
  ExplanationDepth,
  Mastery,
  NextItem,
  Question,
} from "./domain";

export const CALLABLE = {
  ingestVault: "ingestVault",
  explainConcept: "explainConcept",
  generateQuestions: "generateQuestions",
  submitAnswer: "submitAnswer",
  requestHint: "requestHint",
  nextItem: "nextItem",
} as const;

export type CallableName = (typeof CALLABLE)[keyof typeof CALLABLE];

// --- ingestVault ----------------------------------------------------------
// The client uploads the .zip to Cloud Storage, then calls this with the path.
// Re-importing is idempotent: concepts are upserted by id, mastery is preserved.
export interface IngestVaultRequest {
  storagePath: string; // gs path of the uploaded zip, scoped to the user
}
export interface IngestVaultResponse {
  importId: string;
  conceptCount: number;
  subjects: string[];
  /** Non-fatal issues: unresolved wikilinks, notes with no frontmatter, etc. */
  warnings: string[];
}

// --- explainConcept -------------------------------------------------------
// Checks explanationCache first; only calls the model on a miss.
export interface ExplainConceptRequest {
  conceptId: string;
  depth?: ExplanationDepth; // defaults to sequencer's suggestion / "standard"
}
export interface ExplainConceptResponse {
  conceptId: string;
  depth: ExplanationDepth;
  markdown: string;
  model: string;
  cached: boolean;
}

// --- generateQuestions ----------------------------------------------------
export interface GenerateQuestionsRequest {
  conceptId: string;
  count?: number; // default 3 — a mix of recall / application / why
}
export interface GenerateQuestionsResponse {
  conceptId: string;
  questions: Question[];
  model: string;
}

// --- submitAnswer ---------------------------------------------------------
// Grades a free-text answer AND applies the SM-2 / mastery update atomically,
// returning both the feedback and the new learner state. This is the core of
// the teach->grade->update loop and must stay server-side.
export interface SubmitAnswerRequest {
  conceptId: string;
  questionId?: string;
  question: string; // the prompt text (so grading has context without a re-fetch)
  answer: string;
  sessionId?: string;
}
export interface GradeResult {
  quality: number; // 0..5 — feeds SM-2
  score: number; // 0..1 — normalized, feeds masteryScore
  /** Partial-credit, intuition-first feedback shown to the learner. */
  feedback: string;
  whatWasRight: string[];
  whatWasMissing: string[];
  correctedIntuition: string;
  model: string;
}
export interface SubmitAnswerResponse {
  grade: GradeResult;
  mastery: Mastery; // updated learner state for this concept
}

// --- requestHint ----------------------------------------------------------
// When the learner is stuck: a nudge, never the full answer.
export interface RequestHintRequest {
  conceptId: string;
  question: string;
  partialAnswer?: string;
}
export interface RequestHintResponse {
  hint: string;
  model: string;
}

// --- nextItem -------------------------------------------------------------
// The adaptive sequencer: what should the learner do right now?
export interface NextItemRequest {
  /** Optional subject filter; omit to consider the whole vault. */
  subject?: string;
}
export type NextItemResponse = NextItem;

// --- Generic callable error payload --------------------------------------
export interface CallableErrorDetail {
  code: string;
  message: string;
}

/** Convenience map from callable name to its request/response pair. */
export interface CallableContract {
  ingestVault: { request: IngestVaultRequest; response: IngestVaultResponse };
  explainConcept: { request: ExplainConceptRequest; response: ExplainConceptResponse };
  generateQuestions: { request: GenerateQuestionsRequest; response: GenerateQuestionsResponse };
  submitAnswer: { request: SubmitAnswerRequest; response: SubmitAnswerResponse };
  requestHint: { request: RequestHintRequest; response: RequestHintResponse };
  nextItem: { request: NextItemRequest; response: NextItemResponse };
}

// Re-export the domain types most consumers need alongside the API types.
export type { Concept, Mastery, Question, NextItem, ExplanationDepth };
