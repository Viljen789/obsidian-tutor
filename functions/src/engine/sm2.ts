/**
 * Canonical SM-2 spaced-repetition update — PURE.
 *
 * Given the prior SM-2 state and a 0..5 recall quality, returns the next state.
 * No I/O, no Date.now(); time-independent so the unit tests are deterministic.
 *
 * Reference algorithm (SuperMemo SM-2):
 *   - quality < 3  → the answer was a lapse: repetitions reset to 0 and the
 *     interval drops back to 1 day so the item is re-learned soon. The
 *     easeFactor is still nudged by the quality (it can only ever drop here),
 *     floored at 1.3.
 *   - quality >= 3 → a successful recall: repetitions increment and the next
 *     interval grows (1 → 6 → round(prevInterval * easeFactor) → ...).
 *
 * EF update:  EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)), min 1.3.
 */

export interface Sm2State {
  easeFactor: number; // default 2.5
  intervalDays: number;
  repetitions: number;
}

/** Lower bound on the easing factor per the SM-2 spec. */
export const MIN_EASE_FACTOR = 1.3;

/** Round to the nearest whole day (SM-2 intervals are integer days). */
function roundInterval(days: number): number {
  return Math.round(days);
}

/** Pure SM-2 update from a 0..5 quality score. */
export function updateSm2(state: Sm2State, quality: number): Sm2State {
  // Clamp quality into the valid 0..5 band so a stray grade can't corrupt EF.
  const q = Math.max(0, Math.min(5, quality));

  // EF moves the same way regardless of pass/fail; only ever floored at 1.3.
  const nextEaseFactor = Math.max(
    MIN_EASE_FACTOR,
    state.easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)),
  );

  // Lapse: reset the schedule, keep the (now-lower) ease factor.
  if (q < 3) {
    return {
      easeFactor: nextEaseFactor,
      intervalDays: 1,
      repetitions: 0,
    };
  }

  // Successful recall: advance the repetition count and grow the interval.
  const repetitions = state.repetitions + 1;
  let intervalDays: number;
  if (repetitions === 1) {
    intervalDays = 1;
  } else if (repetitions === 2) {
    intervalDays = 6;
  } else {
    intervalDays = roundInterval(state.intervalDays * nextEaseFactor);
  }

  return { easeFactor: nextEaseFactor, intervalDays, repetitions };
}
