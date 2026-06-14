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
  ChatMessage,
  Concept,
  ExplanationDepth,
  Flashcard,
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
  deleteSubject: "deleteSubject",
  generateExam: "generateExam",
  generateFlashcards: "generateFlashcards",
  reviewCard: "reviewCard",
  syncGitHub: "syncGitHub",
  tutorChat: "tutorChat",
  generateMock: "generateMock",
  setPrerequisites: "setPrerequisites",
  createShare: "createShare",
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

// --- deleteSubject --------------------------------------------------------
// Removes every concept in a subject, plus its mastery and cached explanations.
// Server-side (admin) — used to clean up a mistaken or stale import.
export interface DeleteSubjectRequest {
  subject: string;
}
export interface DeleteSubjectResponse {
  subject: string;
  deletedConcepts: number;
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

// --- generateExam ---------------------------------------------------------
// A practice exam: a spread of questions across a subject's concepts, mixing
// recall / application / why. Answers are graded via submitAnswer, so an exam
// doubles as spaced review.
export interface GenerateExamRequest {
  subject: string;
  count?: number; // default ~10
}
export interface GenerateExamResponse {
  subject: string;
  questions: Question[]; // each carries its conceptId for grading
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

// --- generateFlashcards ---------------------------------------------------
// A per-concept recall deck: instant note-derived cloze cards plus a few
// model-written Q/A cards. Cached server-side (like explanations) so repeat
// visits never re-spend a model call. Reviewed via reviewCard (self-graded).
export interface GenerateFlashcardsRequest {
  conceptId: string;
  count?: number; // target total cards — default ~8, clamped server-side
}
export interface GenerateFlashcardsResponse {
  conceptId: string;
  cards: Flashcard[];
  model: string; // "" when the deck is purely note-derived
  cached: boolean;
}

// --- reviewCard -----------------------------------------------------------
// A flashcard review is a self-assessed recall (Anki-style Again/Hard/Good/
// Easy → quality 1/3/4/5). It advances the concept's SM-2 / mastery exactly
// like a graded answer, but spends no model call. Server-side (never trusted
// from the client for the mastery math).
export interface ReviewCardRequest {
  conceptId: string;
  quality: number; // 0..5, clamped server-side
}
export interface ReviewCardResponse {
  mastery: Mastery; // updated learner state for the concept
}

// --- syncGitHub -----------------------------------------------------------
// Re-pull a vault straight from its git repo and re-ingest it, reusing the
// idempotent ingest pipeline (concepts upserted by id; mastery preserved).
// Public repos need no token; private repos pass a GitHub PAT. Returns the
// same shape as ingestVault.
export interface SyncGitHubRequest {
  repoUrl: string; // e.g. https://github.com/owner/repo (optionally .git)
  ref?: string; // branch / tag / commit — defaults to the repo's default branch
  token?: string; // GitHub PAT, only for private repos
  subdir?: string; // optional path within the repo to treat as the vault root
}
export type SyncGitHubResponse = IngestVaultResponse;

// --- setPrerequisites -----------------------------------------------------
// Manual override of a concept's prerequisite edges. Replaces the inferred list
// for sequencing; survives re-imports. Concepts are Functions-written, so this
// is server-side. Returns the sanitized override that was stored.
export interface SetPrerequisitesRequest {
  conceptId: string;
  prerequisites: string[]; // conceptIds to require before this one
}
export interface SetPrerequisitesResponse {
  conceptId: string;
  manualPrerequisites: string[];
}

// --- tutorChat ------------------------------------------------------------
// Ask-a-follow-up: a stateless tutor turn grounded in the concept's notes.
// The client keeps the running transcript (session-local) and re-sends it each
// turn; the server appends nothing but the concept context.
export interface TutorChatRequest {
  conceptId: string;
  messages: ChatMessage[]; // running transcript, oldest first; last is the user's new question
}
export interface TutorChatResponse {
  reply: string;
  model: string;
}

// --- generateMock ---------------------------------------------------------
// Past-exam → mock: the learner pastes a past paper's questions; the model
// writes a fresh set in the same STYLE and difficulty across the subject's
// concepts (never copying the originals). Sat + marked via the exam flow.
export interface GenerateMockRequest {
  subject: string;
  pastExamText: string; // pasted past-exam questions to mimic in style/coverage
  count?: number; // default ~10
}
export interface GenerateMockResponse {
  subject: string;
  questions: Question[]; // each carries its conceptId for grading
  model: string;
}

// --- createShare ----------------------------------------------------------
// Snapshot a subject's concepts (title + explanation) into a public, read-only
// `shares/{id}` doc anyone with the link can view. Server-side so the snapshot
// is trustworthy and the id is an unguessable token.
export interface CreateShareRequest {
  subject: string;
}
export interface CreateShareResponse {
  shareId: string;
  conceptCount: number;
}

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
  deleteSubject: { request: DeleteSubjectRequest; response: DeleteSubjectResponse };
  generateExam: { request: GenerateExamRequest; response: GenerateExamResponse };
  generateFlashcards: { request: GenerateFlashcardsRequest; response: GenerateFlashcardsResponse };
  reviewCard: { request: ReviewCardRequest; response: ReviewCardResponse };
  syncGitHub: { request: SyncGitHubRequest; response: SyncGitHubResponse };
  tutorChat: { request: TutorChatRequest; response: TutorChatResponse };
  generateMock: { request: GenerateMockRequest; response: GenerateMockResponse };
  setPrerequisites: { request: SetPrerequisitesRequest; response: SetPrerequisitesResponse };
  createShare: { request: CreateShareRequest; response: CreateShareResponse };
}

// Re-export the domain types most consumers need alongside the API types.
export type { Concept, Mastery, Question, NextItem, ExplanationDepth, Flashcard };
