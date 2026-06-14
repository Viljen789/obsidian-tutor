/**
 * FSRS (Free Spaced Repetition Scheduler) — PURE, deterministic, clock-free.
 *
 * FSRS is the modern memory model that replaced SM-2 inside Anki. Instead of a
 * single "ease factor" it tracks two latent variables per concept:
 *
 *   - Stability  S — the number of days for retrievability to decay from 1.0 to
 *     the target 0.9. Bigger S ⇒ the memory lasts longer ⇒ longer interval.
 *   - Difficulty D — how hard the concept is to retain, clamped to 1..10. Higher
 *     D makes stability grow more slowly on each successful review.
 *
 * After every review FSRS updates D and S from the rating and the time elapsed,
 * then schedules the next review at the interval that lands retrievability back
 * on the desired retention (0.9 here). This module is the math only: no Date.now,
 * no I/O, no mutation. Callers inject `nowMs`/`lastReviewedMs`.
 *
 * ─── Source ──────────────────────────────────────────────────────────────────
 * Algorithm: FSRS v4.5, the published reference in
 *   open-spaced-repetition/fsrs4anki — "The Algorithm" wiki page
 *   (https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm)
 * and the `ts-fsrs` / `py-fsrs` open-source implementations. The 17-weight
 * DEFAULT parameter vector below is the project's published default (the value
 * shipped as the optimiser's starting point and Anki's stock parameters).
 */

/**
 * Canonical FSRS-4.5 DEFAULT weights `w[0..16]` (17 parameters).
 *
 * Source: open-spaced-repetition default parameters (fsrs4anki v4.5 / ts-fsrs
 * `generatorParameters` default `w`). Roles of each weight:
 *   w[0..3]  initial stability per rating (Again, Hard, Good, Easy)
 *   w[4]     initial-difficulty base
 *   w[5]     initial-difficulty rating slope
 *   w[6]     difficulty update step per rating delta
 *   w[7]     difficulty mean-reversion strength (pull back toward the easy anchor)
 *   w[8]     stability-growth scale on successful recall
 *   w[9]     retrievability penalty exponent on stability growth
 *   w[10]    low-stability bonus exponent on stability growth
 *   w[11..14] post-lapse (forgetting) stability factors
 *   w[15]    "hard penalty" multiplier (rating = Hard shrinks the gain)
 *   w[16]    "easy bonus" multiplier  (rating = Easy boosts the gain)
 */
export const FSRS_DEFAULT_WEIGHTS: readonly number[] = [
  0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616, 0.1544,
  1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407, 2.9466,
] as const;

/**
 * Forgetting-curve constants. Retrievability after `t` days at stability `S`:
 *   R(t, S) = (1 + FACTOR * t / S) ^ DECAY
 * with DECAY = -0.5 and FACTOR = 0.9^(1/DECAY) - 1 = 19/81 ≈ 0.2345.
 * These are the FSRS-4.5 published curve constants.
 */
export const DECAY = -0.5;
export const FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // = 19/81 ≈ 0.23456790123

/** Desired retention at the scheduled interval. FSRS schedules to R = 0.9. */
export const DEFAULT_REQUEST_RETENTION = 0.9;

/** Difficulty is clamped to the published 1..10 band. */
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 10;

/** Stability floor — a memory is never modelled as lasting < 0.1 day. */
const MIN_STABILITY = 0.1;

/** FSRS rating: 1=Again (lapse), 2=Hard, 3=Good, 4=Easy. */
export type FsrsRating = 1 | 2 | 3 | 4;

export interface FsrsScheduleInput {
  /** Prior memory stability in days. Absent ⇒ this is the first review. */
  stability?: number;
  /** Prior difficulty 1..10. Absent ⇒ this is the first review. */
  difficulty?: number;
  /** Epoch ms of the previous review. Ignored on the first review. */
  lastReviewedMs: number | null;
  /** Epoch ms "now" (injected, never Date.now). */
  nowMs: number;
  /** Mapped FSRS rating 1..4. */
  rating: FsrsRating;
}

export interface FsrsState {
  /** Updated memory stability in days (>= MIN_STABILITY). */
  stability: number;
  /** Updated difficulty, clamped 1..10. */
  difficulty: number;
  /** Next interval in whole days (>= 1) for the desired retention. */
  intervalDays: number;
}

/** Replace NaN/±Infinity with a finite fallback so bad inputs can't propagate. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Clamp difficulty into the published 1..10 band (also scrubs NaN). */
function clampDifficulty(d: number): number {
  return Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, finiteOr(d, MIN_DIFFICULTY)));
}

/** Safe weight lookup (noUncheckedIndexedAccess returns number | undefined). */
function w(i: number): number {
  return FSRS_DEFAULT_WEIGHTS[i] ?? 0;
}

/**
 * Map the app's 0..5 recall `quality` to an FSRS rating 1..4.
 *
 * The product grades answers 0..5; FSRS only knows four buttons. Cutoffs (chosen
 * for monotonicity — a better quality never yields a worse rating):
 *   quality <= 1  → Again (1)   total failure / blank
 *   quality 2..3  → Hard  (2)   recalled but shaky (2 is a near-miss, 3 a slog)
 *   quality == 4  → Good  (3)   solid recall
 *   quality >= 5  → Easy  (4)   effortless
 *
 * Note: the legacy SM-2 boundary treated quality < 3 as a *lapse*, but in FSRS a
 * "Hard" (2) is still a SUCCESS, not a forget. We deliberately split there: only
 * quality <= 1 is a true lapse (Again). quality 2..3 are passing-but-hard. This
 * matches FSRS semantics where Hard grows stability (slowly) rather than resetting
 * it. `applyGrade` keeps SM-2's own lapse threshold (q < 3) for the legacy
 * `repetitions` field separately; the two notions of "lapse" are intentionally
 * distinct.
 */
export function qualityToRating(quality: number): FsrsRating {
  const q = finiteOr(quality, 0);
  if (q <= 1) return 1; // Again
  if (q < 4) return 2; // Hard (covers 2 and 3)
  if (q < 5) return 3; // Good (covers [4,5))
  return 4; // Easy (5+)
}

/**
 * Initial stability for a first-ever review = w[rating-1], floored.
 * Easy (w[3]) > Good (w[2]) > Hard (w[1]) > Again (w[0]) by construction of the
 * default weights, so a stronger first answer schedules further out.
 */
export function initStability(rating: FsrsRating): number {
  return Math.max(MIN_STABILITY, w(rating - 1));
}

/**
 * Initial difficulty for a first-ever review:
 *   D0(r) = w[4] - exp(w[5] * (r - 1)) + 1
 * (FSRS-4.5 init formula), clamped to 1..10. Lower rating ⇒ higher difficulty.
 */
export function initDifficulty(rating: FsrsRating): number {
  const d0 = w(4) - Math.exp(w(5) * (rating - 1)) + 1;
  return clampDifficulty(d0);
}

/**
 * Retrievability after `elapsedDays` at stability `S` (the forgetting curve):
 *   R = (1 + FACTOR * t / S) ^ DECAY
 * Clamped to (0,1]. Used to weight stability growth on the next review.
 */
export function retrievability(elapsedDays: number, stability: number): number {
  const t = Math.max(0, finiteOr(elapsedDays, 0));
  const s = Math.max(MIN_STABILITY, finiteOr(stability, MIN_STABILITY));
  const r = Math.pow(1 + FACTOR * (t / s), DECAY);
  return Math.min(1, Math.max(0, finiteOr(r, 0)));
}

/**
 * Difficulty update after a review (FSRS-4.5):
 *   ΔD      = -w[6] * (rating - 3)              // Good (3) leaves D unchanged
 *   D'      = D + ΔD
 *   D_new   = w[7] * D0(Easy) + (1 - w[7]) * D' // mean-reversion to the easy anchor
 * Clamped 1..10. Harder ratings push D up; Easy pulls it down; every step decays
 * a little toward the "Easy" difficulty so D doesn't drift unboundedly.
 */
export function nextDifficulty(difficulty: number, rating: FsrsRating): number {
  const d = clampDifficulty(difficulty);
  const deltaD = -w(6) * (rating - 3);
  const dPrime = d + deltaD;
  // Mean-reversion target: the difficulty an "Easy" first answer would assign.
  const anchor = initDifficulty(4);
  const dNew = w(7) * anchor + (1 - w(7)) * dPrime;
  return clampDifficulty(dNew);
}

/**
 * Stability after a SUCCESSFUL recall (rating ≥ 2), FSRS-4.5:
 *   S' = S * (1 + exp(w[8])
 *               * (11 - D)
 *               * S^(-w[9])
 *               * (exp(w[10] * (1 - R)) - 1)
 *               * hardPenalty       (w[15] when rating==Hard, else 1)
 *               * easyBonus)        (w[16] when rating==Easy, else 1)
 * Growth shrinks as D rises and as S is already large, and grows when R was low
 * (you successfully recalled something you were about to forget ⇒ big boost).
 */
export function nextStabilityOnSuccess(
  stability: number,
  difficulty: number,
  reviewR: number,
  rating: FsrsRating,
): number {
  const s = Math.max(MIN_STABILITY, finiteOr(stability, MIN_STABILITY));
  const d = clampDifficulty(difficulty);
  const r = Math.min(1, Math.max(0, finiteOr(reviewR, 0)));

  const hardPenalty = rating === 2 ? w(15) : 1;
  const easyBonus = rating === 4 ? w(16) : 1;

  const growth =
    Math.exp(w(8)) *
    (11 - d) *
    Math.pow(s, -w(9)) *
    (Math.exp(w(10) * (1 - r)) - 1) *
    hardPenalty *
    easyBonus;

  const sNew = s * (1 + finiteOr(growth, 0));
  return Math.max(MIN_STABILITY, finiteOr(sNew, MIN_STABILITY));
}

/**
 * Stability after a LAPSE (rating = Again), FSRS-4.5 post-lapse formula:
 *   S_lapse = w[11]
 *             * D^(-w[12])
 *             * ((S + 1)^w[13] - 1)
 *             * exp(w[14] * (1 - R))
 * The new stability is also capped at the prior stability (a forget never makes
 * the memory *more* stable) and floored. This is what shortens the interval back
 * toward ~1 day after a failure.
 */
export function nextStabilityOnLapse(
  stability: number,
  difficulty: number,
  reviewR: number,
): number {
  const s = Math.max(MIN_STABILITY, finiteOr(stability, MIN_STABILITY));
  const d = clampDifficulty(difficulty);
  const r = Math.min(1, Math.max(0, finiteOr(reviewR, 0)));

  const sLapse =
    w(11) *
    Math.pow(d, -w(12)) *
    (Math.pow(s + 1, w(13)) - 1) *
    Math.exp(w(14) * (1 - r));

  // A lapse must not increase stability; clamp to [MIN_STABILITY, prior S].
  const capped = Math.min(s, finiteOr(sLapse, MIN_STABILITY));
  return Math.max(MIN_STABILITY, capped);
}

/**
 * Days until retrievability falls to `requestRetention`, given stability `S`:
 *   I = (S / FACTOR) * (requestRetention^(1/DECAY) - 1)
 * (the forgetting curve solved for t). Clamped to >= 1 day and rounded — the app
 * schedules in whole days.
 */
export function nextInterval(
  stability: number,
  requestRetention: number = DEFAULT_REQUEST_RETENTION,
): number {
  const s = Math.max(MIN_STABILITY, finiteOr(stability, MIN_STABILITY));
  const rr = Math.min(0.999, Math.max(0.001, finiteOr(requestRetention, DEFAULT_REQUEST_RETENTION)));
  const raw = (s / FACTOR) * (Math.pow(rr, 1 / DECAY) - 1);
  const rounded = Math.round(finiteOr(raw, 1));
  return Math.max(1, rounded);
}

/**
 * Pure FSRS scheduling step. Given prior {stability, difficulty} (absent ⇒ first
 * review), the previous review time, "now", and the rating, returns the new
 * stability, difficulty, and the next interval in whole days.
 *
 * First review:   S = initStability(rating),  D = initDifficulty(rating).
 * Subsequent:     elapsed = (now - lastReviewed) in days → R → update D, then S
 *                 via the success or lapse formula.
 */
export function fsrsSchedule(input: FsrsScheduleInput): FsrsState {
  const { stability, difficulty, lastReviewedMs, nowMs, rating } = input;

  const hasPrior =
    typeof stability === "number" &&
    Number.isFinite(stability) &&
    typeof difficulty === "number" &&
    Number.isFinite(difficulty);

  // ── First-ever review: seed S and D straight from the rating. ──
  if (!hasPrior) {
    const s = initStability(rating);
    const d = initDifficulty(rating);
    return { stability: s, difficulty: d, intervalDays: nextInterval(s) };
  }

  // ── Subsequent review. ──
  const priorS = Math.max(MIN_STABILITY, stability!);
  const priorD = clampDifficulty(difficulty!);

  // Elapsed days since the last review (>= 0). If lastReviewedMs is missing,
  // treat as same-day (elapsed 0 ⇒ R ≈ 1).
  const elapsedMs = lastReviewedMs == null ? 0 : nowMs - lastReviewedMs;
  const elapsedDays = Math.max(0, finiteOr(elapsedMs, 0) / 86_400_000);
  const reviewR = retrievability(elapsedDays, priorS);

  const newD = nextDifficulty(priorD, rating);
  const newS =
    rating === 1
      ? nextStabilityOnLapse(priorS, priorD, reviewR)
      : nextStabilityOnSuccess(priorS, priorD, reviewR, rating);

  return { stability: newS, difficulty: newD, intervalDays: nextInterval(newS) };
}
