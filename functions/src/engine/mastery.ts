/**
 * Learner-model updates — PURE.
 *
 * `newMastery` mints fresh state for a never-seen concept. `applyGrade` folds a
 * graded answer into that state: it advances the FSRS scheduler (stability +
 * difficulty → next interval/dueDate), blends the masteryScore via an
 * exponentially-weighted moving average, recomputes the status, and recomputes
 * the dueDate from the injected `nowMs` (never Date.now()). Returns a brand-new
 * object so callers can treat mastery as immutable.
 *
 * SCHEDULER NOTE: the schedule (stability / difficulty / intervalDays / dueDate)
 * is now FSRS-4.5 (see ./fsrs). The legacy SM-2 fields are kept for UI/back-compat:
 *   - `intervalDays` mirrors the FSRS interval (whole days),
 *   - `repetitions`  keeps the SM-2 meaning (consecutive successful recalls;
 *     incremented on a pass q>=3, reset to 0 on a lapse q<3) so `deriveStatus`
 *     is unchanged,
 *   - `easeFactor`   is now vestigial and simply carried forward (default 2.5).
 * masteryScore (EWMA) and status (`deriveStatus`) are computed EXACTLY as before;
 * only the schedule moved to FSRS.
 */
import type { Mastery, MasteryStatus } from "@tutor/shared";
import { fsrsSchedule, qualityToRating } from "./fsrs";

/** Weight on the newest score in the masteryScore EWMA: 0.6*old + 0.4*new. */
export const MASTERY_EWMA_ALPHA = 0.4;

/** masteryScore at/above this marks a concept "mastered" (mirrors UserSettings default). */
export const MASTERED_THRESHOLD = 0.85;

/** Default ease factor — vestigial under FSRS, retained for back-compat. */
const DEFAULT_EASE_FACTOR = 2.5;

/**
 * Legacy SM-2 lapse threshold for the `repetitions` counter only. A graded
 * answer with quality < this resets the consecutive-success streak to 0. (FSRS
 * has its own, stricter notion of a lapse — rating "Again", quality <= 1 — used
 * for the SCHEDULE; the two are intentionally separate. See ./fsrs.)
 */
const REPETITION_LAPSE_THRESHOLD = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Fresh learner state for a never-seen concept. */
export function newMastery(conceptId: string): Mastery {
  return {
    conceptId,
    status: "new",
    masteryScore: 0,
    easeFactor: DEFAULT_EASE_FACTOR,
    intervalDays: 0,
    repetitions: 0,
    lastReviewed: null,
    dueDate: null,
    history: [],
  };
}

/**
 * Derive the learner's status from the post-update schedule state + masteryScore.
 *   - mastered : masteryScore >= masteredThreshold
 *   - review   : has at least one successful repetition (it's now scheduled)
 *   - learning : answered but not yet successfully repeated
 *
 * UNCHANGED from the SM-2 era — only the schedule moved to FSRS.
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
 * Apply a graded answer: advance FSRS, blend masteryScore, recompute status +
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

  // Clamp quality into 0..5 so a stray grade can't corrupt the schedule/streak.
  const q = Math.max(0, Math.min(5, Number.isFinite(quality) ? quality : 0));

  // ── FSRS schedule advance ──────────────────────────────────────────────────
  // First review (no prior stability/difficulty) seeds S/D from the rating;
  // subsequent reviews update them from elapsed time + rating.
  const rating = qualityToRating(q);
  const lastReviewedMs = mastery.lastReviewed ? Date.parse(mastery.lastReviewed) : null;
  const sched = fsrsSchedule({
    stability: mastery.stability,
    difficulty: mastery.difficulty,
    lastReviewedMs: Number.isFinite(lastReviewedMs as number) ? lastReviewedMs : null,
    nowMs,
    rating,
  });

  // ── Legacy SM-2 repetition counter (drives deriveStatus; UNCHANGED rule) ────
  // Pass (q >= 3) increments the streak; lapse (q < 3) resets it to 0.
  const repetitions = q < REPETITION_LAPSE_THRESHOLD ? 0 : mastery.repetitions + 1;

  // EWMA blend: 0.6 * old + 0.4 * new. (UNCHANGED.)
  const masteryScore =
    (1 - MASTERY_EWMA_ALPHA) * mastery.masteryScore + MASTERY_EWMA_ALPHA * clampedScore;

  const nowIso = new Date(nowMs).toISOString();
  const dueIso = new Date(nowMs + sched.intervalDays * MS_PER_DAY).toISOString();

  return {
    conceptId: mastery.conceptId,
    status: deriveStatus(masteryScore, repetitions, masteredThreshold),
    masteryScore,
    // easeFactor is vestigial under FSRS — carry the prior value forward.
    easeFactor: mastery.easeFactor,
    intervalDays: sched.intervalDays,
    repetitions,
    // FSRS scheduler state.
    stability: sched.stability,
    difficulty: sched.difficulty,
    lastReviewed: nowIso,
    dueDate: dueIso,
    // New array, original history untouched (immutability).
    history: [...mastery.history, { date: nowIso, quality: q }],
  };
}
