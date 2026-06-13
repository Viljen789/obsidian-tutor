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
  /** Original path inside the vault, e.g. "Databases/Indexing.md". */
  sourcePath: string;
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
