import { describe, it, expect } from "vitest";
import {
  fsrsSchedule,
  qualityToRating,
  initStability,
  initDifficulty,
  nextDifficulty,
  nextInterval,
  retrievability,
  nextStabilityOnSuccess,
  nextStabilityOnLapse,
  FSRS_DEFAULT_WEIGHTS,
  FACTOR,
  DECAY,
  MIN_DIFFICULTY,
  MAX_DIFFICULTY,
  type FsrsRating,
} from "./fsrs";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 13, 12, 0, 0); // 2026-06-13T12:00:00Z
const RATINGS: FsrsRating[] = [1, 2, 3, 4];

describe("FSRS constants", () => {
  it("ships the 17-weight FSRS-4.5 default vector", () => {
    expect(FSRS_DEFAULT_WEIGHTS).toHaveLength(17);
    // First four weights are the per-rating initial stabilities and must be
    // strictly increasing (Again < Hard < Good < Easy).
    expect(FSRS_DEFAULT_WEIGHTS[0]).toBeLessThan(FSRS_DEFAULT_WEIGHTS[1]!);
    expect(FSRS_DEFAULT_WEIGHTS[1]).toBeLessThan(FSRS_DEFAULT_WEIGHTS[2]!);
    expect(FSRS_DEFAULT_WEIGHTS[2]).toBeLessThan(FSRS_DEFAULT_WEIGHTS[3]!);
  });

  it("derives the forgetting-curve factor from DECAY (FACTOR = 0.9^(1/DECAY) - 1)", () => {
    expect(DECAY).toBe(-0.5);
    expect(FACTOR).toBeCloseTo(19 / 81, 12);
  });
});

describe("qualityToRating — 0..5 quality → 1..4 rating, monotone", () => {
  it("maps the documented cutoffs", () => {
    expect(qualityToRating(0)).toBe(1); // Again
    expect(qualityToRating(1)).toBe(1); // Again
    expect(qualityToRating(2)).toBe(2); // Hard
    expect(qualityToRating(3)).toBe(2); // Hard
    expect(qualityToRating(4)).toBe(3); // Good
    expect(qualityToRating(5)).toBe(4); // Easy
  });

  it("is non-decreasing across the whole 0..5 range", () => {
    let prev = 0;
    for (let q = 0; q <= 5; q++) {
      const r = qualityToRating(q);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it("tolerates NaN / out-of-range quality (defaults to Again, clamps high)", () => {
    expect(qualityToRating(NaN)).toBe(1);
    expect(qualityToRating(-10)).toBe(1);
    expect(qualityToRating(99)).toBe(4);
  });
});

describe("first-review initialisation", () => {
  it("initial stability is ordered Easy > Good > Hard > Again", () => {
    const s = RATINGS.map(initStability);
    expect(s[3]).toBeGreaterThan(s[2]!);
    expect(s[2]).toBeGreaterThan(s[1]!);
    expect(s[1]).toBeGreaterThan(s[0]!);
    // Equals the raw default weights w[0..3].
    expect(initStability(1)).toBeCloseTo(FSRS_DEFAULT_WEIGHTS[0]!, 10);
    expect(initStability(4)).toBeCloseTo(FSRS_DEFAULT_WEIGHTS[3]!, 10);
  });

  it("initial difficulty is ordered Again > Hard > Good > Easy and clamped 1..10", () => {
    const d = RATINGS.map(initDifficulty);
    expect(d[0]).toBeGreaterThan(d[1]!); // Again hardest
    expect(d[1]).toBeGreaterThan(d[2]!);
    expect(d[2]).toBeGreaterThan(d[3]!); // Easy easiest
    for (const x of d) {
      expect(x).toBeGreaterThanOrEqual(MIN_DIFFICULTY);
      expect(x).toBeLessThanOrEqual(MAX_DIFFICULTY);
    }
  });

  it("fsrsSchedule with no prior seeds S and D straight from the rating", () => {
    for (const r of RATINGS) {
      const out = fsrsSchedule({ lastReviewedMs: null, nowMs: NOW, rating: r });
      expect(out.stability).toBeCloseTo(initStability(r), 10);
      expect(out.difficulty).toBeCloseTo(initDifficulty(r), 10);
      expect(out.intervalDays).toBe(nextInterval(initStability(r)));
      expect(out.intervalDays).toBeGreaterThanOrEqual(1);
    }
  });

  it("a stronger first answer schedules further out", () => {
    const again = fsrsSchedule({ lastReviewedMs: null, nowMs: NOW, rating: 1 });
    const good = fsrsSchedule({ lastReviewedMs: null, nowMs: NOW, rating: 3 });
    const easy = fsrsSchedule({ lastReviewedMs: null, nowMs: NOW, rating: 4 });
    expect(good.intervalDays).toBeGreaterThanOrEqual(again.intervalDays);
    expect(easy.intervalDays).toBeGreaterThan(good.intervalDays);
  });
});

describe("forgetting curve — retrievability(t, S)", () => {
  it("is 1 at t=0 and decays monotonically", () => {
    expect(retrievability(0, 10)).toBeCloseTo(1, 10);
    const r1 = retrievability(5, 10);
    const r2 = retrievability(20, 10);
    expect(r1).toBeLessThan(1);
    expect(r2).toBeLessThan(r1);
  });

  it("hits the target retention 0.9 at t = S (definition of stability)", () => {
    // By construction the interval for R=0.9 is ~S days; R at exactly t=S ≈ 0.9.
    expect(retrievability(10, 10)).toBeCloseTo(0.9, 6);
  });

  it("stays within (0,1] and tolerates negative / NaN inputs", () => {
    expect(retrievability(-5, 10)).toBeCloseTo(1, 10); // clamped to t=0
    expect(retrievability(NaN, NaN)).toBeLessThanOrEqual(1);
    expect(retrievability(NaN, NaN)).toBeGreaterThanOrEqual(0);
  });
});

describe("nextInterval — schedule for desired retention", () => {
  it("is at least 1 day and rounds to whole days", () => {
    expect(nextInterval(0.01)).toBe(1);
    const i = nextInterval(10);
    expect(Number.isInteger(i)).toBe(true);
    expect(i).toBeGreaterThanOrEqual(1);
  });

  it("grows roughly linearly with stability", () => {
    expect(nextInterval(50)).toBeGreaterThan(nextInterval(10));
    expect(nextInterval(10)).toBeGreaterThan(nextInterval(2));
  });
});

describe("subsequent reviews — success grows stability/interval", () => {
  it("a successful recall (Good) increases stability and interval", () => {
    const first = fsrsSchedule({ lastReviewedMs: null, nowMs: NOW, rating: 3 });
    const reviewedOn = NOW + first.intervalDays * DAY;
    const second = fsrsSchedule({
      stability: first.stability,
      difficulty: first.difficulty,
      lastReviewedMs: NOW,
      nowMs: reviewedOn,
      rating: 3,
    });
    expect(second.stability).toBeGreaterThan(first.stability);
    expect(second.intervalDays).toBeGreaterThan(first.intervalDays);
  });

  it("intervals grow across a chain of Good reviews (each on its due date)", () => {
    let st = fsrsSchedule({ lastReviewedMs: null, nowMs: NOW, rating: 3 });
    let last = NOW;
    let prevInterval = st.intervalDays;
    for (let i = 0; i < 4; i++) {
      const now = last + st.intervalDays * DAY;
      st = fsrsSchedule({
        stability: st.stability,
        difficulty: st.difficulty,
        lastReviewedMs: last,
        nowMs: now,
        rating: 3,
      });
      expect(st.intervalDays).toBeGreaterThan(prevInterval);
      prevInterval = st.intervalDays;
      last = now;
    }
  });

  it("Easy grows stability more than Good, which beats Hard (same prior)", () => {
    const prior = { stability: 10, difficulty: 5 };
    const args = { ...prior, lastReviewedMs: NOW - 10 * DAY, nowMs: NOW };
    const hard = fsrsSchedule({ ...args, rating: 2 });
    const good = fsrsSchedule({ ...args, rating: 3 });
    const easy = fsrsSchedule({ ...args, rating: 4 });
    expect(good.stability).toBeGreaterThan(hard.stability);
    expect(easy.stability).toBeGreaterThan(good.stability);
  });

  it("recalling a near-forgotten item (low R) boosts stability more than an easy one (high R)", () => {
    const prior = { stability: 10, difficulty: 5 };
    // Long overdue ⇒ low R at review.
    const overdue = nextStabilityOnSuccess(prior.stability, prior.difficulty, retrievability(40, 10), 3);
    // Reviewed early ⇒ high R at review.
    const early = nextStabilityOnSuccess(prior.stability, prior.difficulty, retrievability(1, 10), 3);
    expect(overdue).toBeGreaterThan(early);
  });
});

describe("subsequent reviews — a lapse (Again) drops stability + shortens interval", () => {
  it("Again reduces stability below the prior and never above it", () => {
    for (const priorS of [0.5, 1, 3, 6, 10, 30, 100]) {
      const out = fsrsSchedule({
        stability: priorS,
        difficulty: 5,
        lastReviewedMs: NOW - Math.round(priorS) * DAY,
        nowMs: NOW,
        rating: 1,
      });
      expect(out.stability).toBeLessThan(priorS);
    }
  });

  it("a Good→Again sequence collapses the interval back to ~1 day", () => {
    const good = fsrsSchedule({ lastReviewedMs: null, nowMs: NOW, rating: 3 });
    const reviewedOn = NOW + good.intervalDays * DAY;
    const lapsed = fsrsSchedule({
      stability: good.stability,
      difficulty: good.difficulty,
      lastReviewedMs: NOW,
      nowMs: reviewedOn,
      rating: 1,
    });
    expect(lapsed.stability).toBeLessThan(good.stability);
    expect(lapsed.intervalDays).toBe(1);
  });

  it("a lapse raises difficulty (the concept got harder)", () => {
    const before = 5;
    const after = nextDifficulty(before, 1); // Again
    expect(after).toBeGreaterThan(before);
  });

  it("post-lapse stability is floored and never negative", () => {
    const s = nextStabilityOnLapse(0.1, 10, 0.0);
    expect(s).toBeGreaterThan(0);
  });
});

describe("difficulty dynamics", () => {
  it("Good leaves difficulty essentially flat; Hard raises it; Easy lowers it", () => {
    const d = 5;
    const afterHard = nextDifficulty(d, 2);
    const afterGood = nextDifficulty(d, 3);
    const afterEasy = nextDifficulty(d, 4);
    expect(afterHard).toBeGreaterThan(afterGood);
    expect(afterEasy).toBeLessThan(afterGood);
    // Good barely moves D (mean-reversion only).
    expect(Math.abs(afterGood - d)).toBeLessThan(0.5);
  });

  it("difficulty stays clamped to 1..10 under repeated extreme ratings", () => {
    let d = 5;
    for (let i = 0; i < 50; i++) d = nextDifficulty(d, 1); // hammer Again
    expect(d).toBeLessThanOrEqual(MAX_DIFFICULTY);
    expect(d).toBeGreaterThanOrEqual(MIN_DIFFICULTY);
    let e = 5;
    for (let i = 0; i < 50; i++) e = nextDifficulty(e, 4); // hammer Easy
    expect(e).toBeGreaterThanOrEqual(MIN_DIFFICULTY);
    expect(e).toBeLessThanOrEqual(MAX_DIFFICULTY);
  });
});

describe("determinism & robustness", () => {
  it("is deterministic — identical inputs yield identical output", () => {
    const input = {
      stability: 7.5,
      difficulty: 4.2,
      lastReviewedMs: NOW - 5 * DAY,
      nowMs: NOW,
      rating: 3 as const,
    };
    expect(fsrsSchedule(input)).toEqual(fsrsSchedule(input));
  });

  it("treats NaN prior stability/difficulty as a fresh first review", () => {
    const out = fsrsSchedule({
      stability: NaN,
      difficulty: NaN,
      lastReviewedMs: NOW - DAY,
      nowMs: NOW,
      rating: 3,
    });
    expect(out.stability).toBeCloseTo(initStability(3), 10);
    expect(out.difficulty).toBeCloseTo(initDifficulty(3), 10);
  });

  it("treats negative elapsed time (clock skew) as 0 elapsed, R≈1", () => {
    const out = fsrsSchedule({
      stability: 10,
      difficulty: 5,
      lastReviewedMs: NOW + DAY, // last review is in the 'future'
      nowMs: NOW,
      rating: 3,
    });
    expect(Number.isFinite(out.stability)).toBe(true);
    expect(out.stability).toBeGreaterThan(0);
    expect(out.intervalDays).toBeGreaterThanOrEqual(1);
  });

  it("always returns finite, positive stability and difficulty for every rating", () => {
    for (const r of RATINGS) {
      const out = fsrsSchedule({
        stability: 10,
        difficulty: 5,
        lastReviewedMs: NOW - 10 * DAY,
        nowMs: NOW,
        rating: r,
      });
      expect(Number.isFinite(out.stability)).toBe(true);
      expect(Number.isFinite(out.difficulty)).toBe(true);
      expect(out.stability).toBeGreaterThan(0);
      expect(out.difficulty).toBeGreaterThanOrEqual(MIN_DIFFICULTY);
      expect(out.difficulty).toBeLessThanOrEqual(MAX_DIFFICULTY);
      expect(Number.isInteger(out.intervalDays)).toBe(true);
      expect(out.intervalDays).toBeGreaterThanOrEqual(1);
    }
  });
});
