/**
 * Next-item policy (the adaptive sequencer) — PURE.
 *
 * Decision order (CONTRACTS §5):
 *   1. Due first  — any concept whose dueDate <= now is reviewed; the MOST
 *      overdue one wins so nothing starves.
 *   2. Else learn — the next status:"new" concept whose every prerequisite has
 *      masteryScore >= settings.masteryThreshold, subject to the daily-new cap.
 *   3. Else none  — nothing due and nothing unlocked; report the concepts that
 *      are blocked purely by unmet prerequisites for transparency.
 *
 * Depth adapts to current mastery: deep for new/weak, standard mid, refresher
 * for high mastery. Concepts with no mastery entry are treated as brand-new.
 */
import type {
  Concept,
  ExplanationDepth,
  Mastery,
  NextItem,
  UserSettings,
} from "@tutor/shared";
import { newMastery } from "./mastery";

export interface SequencerInput {
  concepts: Concept[];
  /** conceptId -> mastery; absent entries are treated as brand-new. */
  masteries: Record<string, Mastery>;
  nowMs: number;
  settings: UserSettings;
  subject?: string;
  /** New concepts already introduced today (for the daily-new cap). */
  newlyIntroducedToday?: number;
}

/** Mastery boundaries that map a score to an explanation depth. */
const REFRESHER_FLOOR = 0.85; // high mastery → light refresher
const STANDARD_FLOOR = 0.5; // mid mastery → standard depth; below → deep

/** Pick an explanation depth from the learner's current mastery on a concept. */
function depthForMastery(score: number): ExplanationDepth {
  if (score >= REFRESHER_FLOOR) return "refresher";
  if (score >= STANDARD_FLOOR) return "standard";
  return "deep";
}

/**
 * The prerequisites the sequencer enforces. A manual override
 * (`manualPrerequisites`) wins over the inferred list, so a learner can correct
 * the graph and the change takes effect immediately.
 */
function effectivePrerequisites(concept: Concept): string[] {
  return concept.manualPrerequisites ?? concept.prerequisites;
}

/** Resolve a concept's mastery, treating a missing entry as brand-new. */
function masteryFor(
  conceptId: string,
  masteries: Record<string, Mastery>,
): Mastery {
  return masteries[conceptId] ?? newMastery(conceptId);
}

/**
 * Decide what to do next. Deterministic given `nowMs`.
 */
export function selectNextItem(input: SequencerInput): NextItem {
  const { masteries, nowMs, settings, subject, newlyIntroducedToday = 0 } = input;

  // Subject filter (optional) — otherwise the whole vault is in play.
  const concepts = subject
    ? input.concepts.filter((c) => c.subject === subject)
    : input.concepts;

  // --- 1. Due for review --------------------------------------------------
  // Collect everything past due, then take the most overdue (smallest dueMs).
  let mostOverdue: { concept: Concept; mastery: Mastery; dueMs: number } | null = null;
  for (const concept of concepts) {
    const mastery = masteryFor(concept.id, masteries);
    if (mastery.dueDate === null) continue;
    const dueMs = Date.parse(mastery.dueDate);
    if (Number.isNaN(dueMs) || dueMs > nowMs) continue;
    if (mostOverdue === null || dueMs < mostOverdue.dueMs) {
      mostOverdue = { concept, mastery, dueMs };
    }
  }
  if (mostOverdue) {
    return {
      action: "review",
      conceptId: mostOverdue.concept.id,
      reason: `Due for review: "${mostOverdue.concept.title}"`,
      suggestedDepth: depthForMastery(mostOverdue.mastery.masteryScore),
    };
  }

  // --- 2. Learn a new concept (prerequisite-gated, daily-capped) ----------
  // A prerequisite is satisfied when its masteryScore >= masteryThreshold.
  const isUnlocked = (concept: Concept): { ok: boolean; missing: string[] } => {
    const missing: string[] = [];
    for (const prereqId of effectivePrerequisites(concept)) {
      const prereqMastery = masteryFor(prereqId, masteries);
      if (prereqMastery.masteryScore < settings.masteryThreshold) {
        missing.push(prereqId);
      }
    }
    return { ok: missing.length === 0, missing };
  };

  const newConcepts = concepts.filter(
    (c) => masteryFor(c.id, masteries).status === "new",
  );

  const dailyCapReached = newlyIntroducedToday >= settings.dailyNewLimit;

  if (!dailyCapReached) {
    const unlocked = newConcepts.find((c) => isUnlocked(c).ok);
    if (unlocked) {
      return {
        action: "learn",
        conceptId: unlocked.id,
        reason: `Foundations ready — time to learn "${unlocked.title}"`,
        // A brand-new concept always starts deep.
        suggestedDepth: depthForMastery(masteryFor(unlocked.id, masteries).masteryScore),
      };
    }
  }

  // --- 3. Nothing due, nothing unlocked -----------------------------------
  // Surface new concepts blocked solely by unmet prerequisites.
  const blocked = newConcepts
    .map((c) => ({ conceptId: c.id, ...isUnlocked(c) }))
    .filter((b) => !b.ok)
    .map((b) => ({ conceptId: b.conceptId, missingPrereqs: b.missing }));

  const reason = dailyCapReached
    ? "Daily new-concept limit reached — come back tomorrow or review."
    : blocked.length > 0
      ? "Nothing due; remaining concepts are blocked by prerequisites."
      : "All caught up — nothing due and nothing new to learn.";

  return {
    action: "none",
    conceptId: null,
    reason,
    suggestedDepth: null,
    blocked,
  };
}
