import { describe, it, expect } from "vitest";
import { updateSm2, MIN_EASE_FACTOR, type Sm2State } from "./sm2";

const FRESH: Sm2State = { easeFactor: 2.5, intervalDays: 0, repetitions: 0 };

describe("updateSm2 — interval growth on repeated quality-5", () => {
  it("grows 1 → 6 → 17 → ... (EF bumped before interval) and never drops EF below 1.3", () => {
    let s = FRESH;

    // First successful review.
    s = updateSm2(s, 5);
    expect(s.repetitions).toBe(1);
    expect(s.intervalDays).toBe(1);

    // Second successful review.
    s = updateSm2(s, 5);
    expect(s.repetitions).toBe(2);
    expect(s.intervalDays).toBe(6);

    // Third: EF is bumped FIRST (canonical SM-2), then interval = round(prev * EF).
    // EF: 2.5 →(q5) 2.6 →(q5) 2.7 →(q5) 2.8; interval = round(6 * 2.8) = 17.
    s = updateSm2(s, 5);
    expect(s.repetitions).toBe(3);
    expect(s.easeFactor).toBeCloseTo(2.8, 10);
    expect(s.intervalDays).toBe(17);

    // Interval keeps growing monotonically; EF stays well above the floor.
    const prev = s.intervalDays;
    s = updateSm2(s, 5);
    expect(s.intervalDays).toBeGreaterThan(prev);
    expect(s.easeFactor).toBeGreaterThanOrEqual(MIN_EASE_FACTOR);
  });

  it("each quality-5 bumps easeFactor by +0.1", () => {
    const s = updateSm2(FRESH, 5);
    expect(s.easeFactor).toBeCloseTo(2.6, 10);
  });
});

describe("updateSm2 — easeFactor floor at 1.3", () => {
  it("repeated low (but passing) quality-3 answers floor EF at 1.3", () => {
    // q=3 → delta = 0.1 - 2*(0.08 + 2*0.02) = 0.1 - 0.24 = -0.14 per call.
    let s: Sm2State = { easeFactor: 1.4, intervalDays: 6, repetitions: 2 };
    s = updateSm2(s, 3); // 1.4 - 0.14 = 1.26 → floored to 1.3
    expect(s.easeFactor).toBe(MIN_EASE_FACTOR);

    // Stays floored, never goes below.
    s = updateSm2(s, 3);
    expect(s.easeFactor).toBe(MIN_EASE_FACTOR);
  });

  it("never returns EF below 1.3 even on quality 0", () => {
    const s = updateSm2({ easeFactor: 1.31, intervalDays: 10, repetitions: 3 }, 0);
    expect(s.easeFactor).toBe(MIN_EASE_FACTOR);
  });
});

describe("updateSm2 — reset on quality < 3", () => {
  it("resets intervalDays → 1 and repetitions → 0 on a lapse", () => {
    // Build up a healthy streak first.
    let s = FRESH;
    s = updateSm2(s, 5); // rep 1
    s = updateSm2(s, 5); // rep 2, interval 6
    s = updateSm2(s, 5); // rep 3, interval 16
    expect(s.repetitions).toBe(3);

    const beforeEf = s.easeFactor;
    s = updateSm2(s, 2); // lapse
    expect(s.repetitions).toBe(0);
    expect(s.intervalDays).toBe(1);
    // EF still adjusts on a lapse (only ever down here) and is floored.
    expect(s.easeFactor).toBeLessThan(beforeEf);
    expect(s.easeFactor).toBeGreaterThanOrEqual(MIN_EASE_FACTOR);
  });

  it("treats every quality below 3 (0,1,2) as a reset", () => {
    for (const q of [0, 1, 2]) {
      const s = updateSm2({ easeFactor: 2.5, intervalDays: 30, repetitions: 5 }, q);
      expect(s.repetitions).toBe(0);
      expect(s.intervalDays).toBe(1);
    }
  });
});

describe("updateSm2 — purity & robustness", () => {
  it("does not mutate the input state", () => {
    const input: Sm2State = { easeFactor: 2.5, intervalDays: 0, repetitions: 0 };
    const snapshot = { ...input };
    updateSm2(input, 5);
    expect(input).toEqual(snapshot);
  });

  it("clamps out-of-range quality into 0..5", () => {
    // quality 9 behaves like 5 (best); quality -3 behaves like 0 (lapse).
    expect(updateSm2(FRESH, 9)).toEqual(updateSm2(FRESH, 5));
    expect(updateSm2(FRESH, -3)).toEqual(updateSm2(FRESH, 0));
  });
});
