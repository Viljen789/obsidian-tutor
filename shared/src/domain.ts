/**
 * Core domain model — the single source of truth shared by `web/` and `functions/`.
 *
 * Timestamp convention: every stored time is an ISO-8601 string at the domain
 * layer (portable, JSON-safe, human-readable in the Firestore console). The
 * Firestore data-access layer converts to/from `Timestamp` at the boundary; the
 * adaptive engine operates on explicit epoch-millis so it stays pure and testable.
 */

export type IsoTimestamp = string;

// ---------------------------------------------------------------------------
// Concepts & graph
// ---------------------------------------------------------------------------

/** Subjects are free-form and entirely vault-driven (e.g. "Databases"). */
export type Subject = string;

export interface Concept {
  /** Stable id derived from the note (slug of sourcePath). */
  id: string;
  title: string;
  subject: Subject;
  /** Raw note content (markdown body, frontmatter stripped). */
  bodyMarkdown: string;
  tags: string[];
  /** conceptIds this note wikilinks to — undirected relatedness. */
  links: string[];
  /** conceptIds that should be learned first — directed (see prerequisite inference). */
  prerequisites: string[];
  /**
   * Manual prerequisite override. When present it REPLACES the inferred
   * `prerequisites` for sequencing. Written by the client (setPrerequisites);
   * ingestion never touches it, so a learner's edits survive re-imports.
   */
  manualPrerequisites?: string[];
  /** Original path inside the vault, e.g. "Databases/Indexing.md". */
  sourcePath: string;
  /**
   * Vault image embeds for this note, uploaded to Storage at ingest. `name` is
   * the embed reference as written (e.g. "er-diagram.png"); `url` is a stable,
   * tokenized download URL the Markdown renderer resolves `![[name]]` against.
   */
  assets?: { name: string; url: string }[];
  /** Groups all concepts written by a single ingestion run. */
  importId: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** How a prerequisite edge was decided — surfaced so the user can audit/override. */
export type PrereqSource = "schedule" | "depth" | "llm" | "manual";

export interface PrereqEdge {
  from: string; // prerequisite conceptId
  to: string; // dependent conceptId
  source: PrereqSource;
  confidence: number; // 0..1
}

// ---------------------------------------------------------------------------
// Learner model (mastery + spaced repetition)
// ---------------------------------------------------------------------------

export type MasteryStatus = "new" | "learning" | "review" | "mastered";

export interface MasteryHistoryEntry {
  date: IsoTimestamp;
  /** SM-2 quality 0..5 for the graded answer. */
  quality: number;
  note?: string;
}

export interface Mastery {
  conceptId: string;
  status: MasteryStatus;
  /** Knowledge-tracing estimate, 0..1. */
  masteryScore: number;

  // SM-2 spaced-repetition state.
  easeFactor: number; // default 2.5
  intervalDays: number; // 0 until first successful review
  repetitions: number; // consecutive successful reviews
  lastReviewed: IsoTimestamp | null;
  dueDate: IsoTimestamp | null;

  /**
   * FSRS scheduler state — memory stability (days) and difficulty (1..10). Set
   * on first review; absent on legacy docs / never-reviewed concepts, in which
   * case the scheduler initialises them from the first rating.
   */
  stability?: number;
  difficulty?: number;

  history: MasteryHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Teaching content
// ---------------------------------------------------------------------------

/** Explanation depth, chosen by the sequencer from current mastery. */
export type ExplanationDepth = "refresher" | "standard" | "deep";

export interface ExplanationCacheEntry {
  conceptId: string;
  depth: ExplanationDepth;
  markdown: string;
  model: string;
  createdAt: IsoTimestamp;
}

export type QuestionType = "recall" | "application" | "why";

export interface Question {
  id: string;
  conceptId: string;
  type: QuestionType;
  prompt: string;
}

/** A cross-concept synthesis question — integrates two or more concepts. */
export interface SynthesisQuestion {
  id: string;
  type: QuestionType;
  prompt: string;
  conceptIds: string[]; // the concepts this question weaves together (>= 2)
}

/** Cached LLM-generated Mermaid diagram for a concept (Functions-written). */
export interface DiagramEntry {
  conceptId: string;
  mermaid: string;
  model: string;
  createdAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Sessions & user
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  startedAt: IsoTimestamp;
  endedAt: IsoTimestamp | null;
  conceptsCovered: string[];
  /** conceptId -> most recent SM-2 quality this session. */
  scores: Record<string, number>;
  summary: string | null;
}

export interface UserProfile {
  uid: string;
  displayName: string | null;
  email: string | null;
  createdAt: IsoTimestamp;
}

export interface UserSettings {
  /** A prerequisite counts as "satisfied" at or above this mastery (0..1). */
  masteryThreshold: number;
  /** Max brand-new concepts to introduce per day. */
  dailyNewLimit: number;
  /** Mastery at/above this marks a concept "mastered". */
  masteredThreshold: number;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  masteryThreshold: 0.6,
  dailyNewLimit: 5,
  masteredThreshold: 0.85,
};

// ---------------------------------------------------------------------------
// Adaptive engine I/O (kept here so client + server agree on the sequencer shape)
// ---------------------------------------------------------------------------

export type NextItemAction = "review" | "learn" | "none";

export interface NextItem {
  action: NextItemAction;
  conceptId: string | null;
  /** Human-readable rationale shown in the UI ("Due for review", "Foundations ready"). */
  reason: string;
  suggestedDepth: ExplanationDepth | null;
  /** Concepts blocked only by unmet prerequisites — surfaced for transparency. */
  blocked?: { conceptId: string; missingPrereqs: string[] }[];
}

// ---------------------------------------------------------------------------
// Flashcards (Wave 2 — fast recall drill; self-graded, feeds the same SM-2 loop)
// ---------------------------------------------------------------------------

/** "cloze" = note-derived fill-in-the-blank; "qa" = model-written question/answer. */
export type FlashcardKind = "cloze" | "qa";

export interface Flashcard {
  id: string;
  conceptId: string;
  kind: FlashcardKind;
  /** Prompt side — a cloze sentence with a blank, or a question. */
  front: string;
  /** Answer side — the hidden term, or the model's answer. */
  back: string;
  /** Optional nudge shown before the answer is revealed. */
  hint?: string;
}

/** A per-concept deck, cached server-side like explanations (a cost guardrail). */
export interface FlashcardDeck {
  conceptId: string;
  cards: Flashcard[];
  /** Model that wrote the qa cards; "" when the deck is purely note-derived. */
  model: string;
  createdAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Activity stats (Wave 2 — daily streak). Client-written, low-stakes like sessions.
// ---------------------------------------------------------------------------

export interface UserStats {
  /** Consecutive calendar days with at least one graded answer / card review. */
  currentStreak: number;
  longestStreak: number;
  /** Local calendar day (YYYY-MM-DD) of the most recent study activity. */
  lastActiveDay: string | null;
  /** Lifetime count of graded answers + card reviews. */
  totalReviews: number;
  updatedAt: IsoTimestamp;
}

export const EMPTY_USER_STATS: UserStats = {
  currentStreak: 0,
  longestStreak: 0,
  lastActiveDay: null,
  totalReviews: 0,
  updatedAt: "",
};

// ---------------------------------------------------------------------------
// Practice-exam history (Wave 2). A client-written record of one sat exam.
// ---------------------------------------------------------------------------

export interface ExamQuestionResult {
  conceptId: string;
  type: QuestionType;
  prompt: string;
  /** SM-2 quality 0..5 from grading, or null if the answer couldn't be graded. */
  quality: number | null;
}

export interface ExamRecord {
  id: string;
  subject: string;
  takenAt: IsoTimestamp;
  /** Wall-clock seconds spent sitting the paper, or null if untimed. */
  durationSec: number | null;
  /** Overall mark, 0..100. */
  scorePercent: number;
  questionCount: number;
  gradedCount: number;
  results: ExamQuestionResult[];
}

// ---------------------------------------------------------------------------
// Tutor chat (Wave 3 — ask-a-follow-up). Session-local on the client; the
// callable is stateless and is re-sent the running transcript each turn.
// ---------------------------------------------------------------------------

export type ChatRole = "user" | "tutor";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// ---------------------------------------------------------------------------
// Study preferences (Wave 3 — exam-readiness countdown). Client-written.
// ---------------------------------------------------------------------------

export interface ExamPrefs {
  /** subject -> exam date (ISO `yyyy-mm-dd`). Drives the readiness countdown. */
  examDates: Record<string, string>;
}

export const EMPTY_EXAM_PREFS: ExamPrefs = { examDates: {} };

// ---------------------------------------------------------------------------
// Shared decks (Wave 3 — read-only public share of a subject). A snapshot,
// written by Functions to a public top-level `shares/{id}` doc.
// ---------------------------------------------------------------------------

export interface SharedConcept {
  id: string;
  title: string;
  subject: string;
  /** The cached explanation markdown if one exists, else the raw note body. */
  markdown: string;
}

export interface ShareDoc {
  id: string;
  subject: string;
  ownerName: string | null;
  createdAt: IsoTimestamp;
  concepts: SharedConcept[];
}

/** Cached one-page revision sheet for a subject (Functions-written). */
export interface CheatSheetEntry {
  subject: string;
  markdown: string;
  model: string;
  createdAt: IsoTimestamp;
}
