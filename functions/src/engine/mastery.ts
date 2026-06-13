/**
 * Learner-model updates — PURE.
 *
 * `newMastery` mints fresh state for a never-seen concept. `applyGrade` folds a
 * graded answer into that state: it advances SM-2, blends the masteryScore via
 * an exponentially-weighted moving average, recomputes the status, and recomputes
 * the dueDate from the injected `nowMs` (never Date.now()). Returns a brand-new
 * object so callers can treat mastery as immutable.
 */
import type { Mastery, MasteryStatus } from "@tutor/shared";
import { updateSm2 } from "./sm2";

/** Weight on the newest score in the masteryScore EWMA: 0.6*old + 0.4*new. */
export const MASTERY_EWMA_ALPHA = 0.4;

/** masteryScore at/above this marks a concept "mastered" (mirrors UserSettings default). */
export const MASTERED_THRESHOLD = 0.85;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Fresh learner state for a never-seen concept. */
export function newMastery(conceptId: string): Mastery {
  return {
    conceptId,
    status: "new",
    masteryScore: 0,
    easeFactor: 2.5,
    intervalDays: 0,
    repetitions: 0,
    lastReviewed: null,
    dueDate: null,
    history: [],
  };
}

/**
 * Derive the learner's status from the post-update SM-2 state + masteryScore.
 *   - mastered : masteryScore >= masteredThreshold
 *   - review   : has at least one successful repetition (it's now scheduled)
 *   - learning : answered but not yet successfully repeated
 */
function deriveStatus(
  masteryScore: number,
  repetitions: number,
  masteredThreshold: number,
): MasteryStatus {
  if (masteryScore >= masteredThreshold) return "mastered";
  if (repetitions >= 1) return "review";
  return "learning";
}

/**
 * Apply a graded answer: advance SM-2, blend masteryScore, recompute status +
 * dueDate, append history. `quality` is 0..5, `score` is 0..1, `nowMs` epoch ms.
 *
 * Pure: returns a NEW Mastery; the input is never mutated.
 */
export function applyGrade(
  mastery: Mastery,
  quality: number,
  score: number,
  nowMs: number,
  masteredThreshold: number = MASTERED_THRESHOLD,
): Mastery {
  // Clamp the normalized score so a bad grade can't push masteryScore out of 0..1.
  const clampedScore = Math.max(0, Math.min(1, score));

  // SM-2 advance from the current schedule state.
  const next = updateSm2(
    {
      easeFactor: mastery.easeFactor,
      intervalDays: mastery.intervalDays,
      repetitions: mastery.repetitions,
    },
    quality,
  );

  // EWMA blend: 0.6 * old + 0.4 * new.
  const masteryScore =
    (1 - MASTERY_EWMA_ALPHA) * mastery.masteryScore + MASTERY_EWMA_ALPHA * clampedScore;

  const nowIso = new Date(nowMs).toISOString();
  const dueIso = new Date(nowMs + next.intervalDays * MS_PER_DAY).toISOString();

  return {
    conceptId: mastery.conceptId,
    status: deriveStatus(masteryScore, next.repetitions, masteredThreshold),
    masteryScore,
    easeFactor: next.easeFactor,
    intervalDays: next.intervalDays,
    repetitions: next.repetitions,
    lastReviewed: nowIso,
    dueDate: dueIso,
    // New array, original history untouched (immutability).
    history: [...mastery.history, { date: nowIso, quality }],
  };
}
