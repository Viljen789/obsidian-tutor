import { describe, it, expect } from "vitest";
import { newMastery, applyGrade, MASTERY_EWMA_ALPHA } from "./mastery";
import type { Mastery } from "@tutor/shared";

// Fixed clock for deterministic dueDate / lastReviewed assertions.
const NOW = Date.UTC(2026, 5, 13, 12, 0, 0); // 2026-06-13T12:00:00.000Z
const NOW_ISO = new Date(NOW).toISOString();
const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe("newMastery", () => {
  it("mints fresh state for a never-seen concept", () => {
    expect(newMastery("c1")).toEqual<Mastery>({
      conceptId: "c1",
      status: "new",
      masteryScore: 0,
      easeFactor: 2.5,
      intervalDays: 0,
      repetitions: 0,
      lastReviewed: null,
      dueDate: null,
      history: [],
    });
  });
});

describe("applyGrade — masteryScore EWMA blend", () => {
  it("blends 0.6*old + 0.4*new", () => {
    const start = { ...newMastery("c1"), masteryScore: 0.5 };
    const out = applyGrade(start, 4, 1.0, NOW);
    // 0.6*0.5 + 0.4*1.0 = 0.7
    expect(out.masteryScore).toBeCloseTo(0.7, 10);
    expect(MASTERY_EWMA_ALPHA).toBe(0.4);
  });

  it("clamps score into 0..1 before blending", () => {
    const start = { ...newMastery("c1"), masteryScore: 0.5 };
    const high = applyGrade(start, 5, 5, NOW); // score clamped to 1
    expect(high.masteryScore).toBeCloseTo(0.7, 10);
    const low = applyGrade(start, 1, -2, NOW); // score clamped to 0
    expect(low.masteryScore).toBeCloseTo(0.3, 10);
  });
});

describe("applyGrade — status transitions", () => {
  it("first passing answer moves new → review (scheduled)", () => {
    const out = applyGrade(newMastery("c1"), 4, 0.6, NOW);
    expect(out.repetitions).toBe(1);
    expect(out.status).toBe("review");
  });

  it("a lapse (q<3) yields status 'learning' (repetitions reset to 0)", () => {
    // Start from a scheduled concept, then fail it.
    const reviewing = applyGrade(newMastery("c1"), 4, 0.6, NOW);
    const lapsed = applyGrade(reviewing, 1, 0.1, NOW);
    expect(lapsed.repetitions).toBe(0);
    expect(lapsed.status).toBe("learning");
  });

  it("marks 'mastered' once masteryScore >= 0.85", () => {
    // Push the score above the threshold with repeated strong answers.
    let m = newMastery("c1");
    for (let i = 0; i < 12; i++) m = applyGrade(m, 5, 1.0, NOW);
    expect(m.masteryScore).toBeGreaterThanOrEqual(0.85);
    expect(m.status).toBe("mastered");
  });

  it("respects a custom masteredThreshold", () => {
    const start = { ...newMastery("c1"), masteryScore: 0.7 };
    // 0.6*0.7 + 0.4*1 = 0.82 — mastered under a 0.8 threshold, not under 0.85.
    expect(applyGrade(start, 5, 1.0, NOW, 0.8).status).toBe("mastered");
    expect(applyGrade(start, 5, 1.0, NOW, 0.85).status).toBe("review");
  });
});

describe("applyGrade — dueDate computed from nowMs + intervalDays", () => {
  it("first success schedules due +1 day from nowMs", () => {
    const out = applyGrade(newMastery("c1"), 5, 0.9, NOW);
    expect(out.intervalDays).toBe(1);
    expect(out.lastReviewed).toBe(NOW_ISO);
    expect(out.dueDate).toBe(new Date(NOW + 1 * MS_PER_DAY).toISOString());
  });

  it("second success schedules due +6 days from nowMs", () => {
    const first = applyGrade(newMastery("c1"), 5, 0.9, NOW);
    const second = applyGrade(first, 5, 0.9, NOW);
    expect(second.intervalDays).toBe(6);
    expect(second.dueDate).toBe(new Date(NOW + 6 * MS_PER_DAY).toISOString());
  });

  it("a lapse reschedules due +1 day from nowMs", () => {
    const out = applyGrade({ ...newMastery("c1"), masteryScore: 0.5 }, 2, 0.2, NOW);
    expect(out.intervalDays).toBe(1);
    expect(out.dueDate).toBe(new Date(NOW + 1 * MS_PER_DAY).toISOString());
  });
});

describe("applyGrade — history & immutability", () => {
  it("appends a history entry with date=ISO(nowMs) and the quality", () => {
    const out = applyGrade(newMastery("c1"), 4, 0.6, NOW);
    expect(out.history).toEqual([{ date: NOW_ISO, quality: 4 }]);
  });

  it("accumulates history across grades", () => {
    const first = applyGrade(newMastery("c1"), 4, 0.6, NOW);
    const second = applyGrade(first, 5, 0.9, NOW + MS_PER_DAY);
    expect(second.history).toHaveLength(2);
    expect(second.history[1]).toEqual({
      date: new Date(NOW + MS_PER_DAY).toISOString(),
      quality: 5,
    });
  });

  it("does not mutate the input mastery", () => {
    const input = newMastery("c1");
    const snapshot = structuredClone(input);
    applyGrade(input, 5, 1.0, NOW);
    expect(input).toEqual(snapshot);
    // The original history array is not shared with the result.
    const out = applyGrade(input, 5, 1.0, NOW);
    expect(out.history).not.toBe(input.history);
  });
});
