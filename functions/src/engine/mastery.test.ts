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

describe("applyGrade — dueDate computed from nowMs + intervalDays (FSRS schedule)", () => {
  it("dueDate always equals nowMs + intervalDays*day, lastReviewed = ISO(now)", () => {
    const out = applyGrade(newMastery("c1"), 5, 0.9, NOW);
    expect(out.lastReviewed).toBe(NOW_ISO);
    expect(out.intervalDays).toBeGreaterThanOrEqual(1);
    expect(out.dueDate).toBe(new Date(NOW + out.intervalDays * MS_PER_DAY).toISOString());
  });

  it("first Easy (q5) review seeds FSRS S/D and schedules ~15 days out", () => {
    // Easy first answer ⇒ initial stability w[3]=15.47 ⇒ interval 15 days.
    const out = applyGrade(newMastery("c1"), 5, 0.9, NOW);
    expect(out.intervalDays).toBe(15);
    expect(out.stability).toBeCloseTo(15.4722, 3);
    expect(out.difficulty).toBeGreaterThan(0);
    expect(out.dueDate).toBe(new Date(NOW + 15 * MS_PER_DAY).toISOString());
  });

  it("a successful follow-up review (on its due date) lengthens the interval", () => {
    const first = applyGrade(newMastery("c1"), 5, 0.9, NOW);
    const dueMs = NOW + first.intervalDays * MS_PER_DAY;
    const second = applyGrade(first, 5, 0.9, dueMs);
    // Stability (and therefore the interval) grows on a successful recall.
    expect(second.stability!).toBeGreaterThan(first.stability!);
    expect(second.intervalDays).toBeGreaterThan(first.intervalDays);
    expect(second.dueDate).toBe(new Date(dueMs + second.intervalDays * MS_PER_DAY).toISOString());
  });

  it("a lapse reschedules due ~1 day out and drops stability", () => {
    // Build a real schedule, then fail it: FSRS shrinks the interval back to ~1d.
    const reviewing = applyGrade(newMastery("c1"), 4, 0.6, NOW);
    const lapsed = applyGrade(reviewing, 1, 0.1, NOW);
    expect(lapsed.intervalDays).toBe(1);
    expect(lapsed.stability!).toBeLessThan(reviewing.stability!);
    expect(lapsed.dueDate).toBe(new Date(NOW + 1 * MS_PER_DAY).toISOString());
  });

  it("a first 'Hard' (q2) answer schedules ~1 day out without a prior schedule", () => {
    const out = applyGrade({ ...newMastery("c1"), masteryScore: 0.5 }, 2, 0.2, NOW);
    expect(out.intervalDays).toBe(1);
    expect(out.dueDate).toBe(new Date(NOW + 1 * MS_PER_DAY).toISOString());
  });
});

describe("applyGrade — FSRS scheduler state", () => {
  it("populates stability & difficulty on the first graded answer", () => {
    const out = applyGrade(newMastery("c1"), 4, 0.7, NOW);
    expect(out.stability).toBeGreaterThan(0);
    expect(out.difficulty).toBeGreaterThanOrEqual(1);
    expect(out.difficulty).toBeLessThanOrEqual(10);
  });

  it("keeps easeFactor vestigial — carried forward at its prior value (2.5)", () => {
    const out = applyGrade(newMastery("c1"), 5, 1.0, NOW);
    expect(out.easeFactor).toBe(2.5);
    const again = applyGrade(out, 4, 0.8, NOW + MS_PER_DAY);
    expect(again.easeFactor).toBe(2.5);
  });

  it("is deterministic — identical inputs give identical schedule output", () => {
    const a = applyGrade({ ...newMastery("c1"), masteryScore: 0.4 }, 4, 0.7, NOW);
    const b = applyGrade({ ...newMastery("c1"), masteryScore: 0.4 }, 4, 0.7, NOW);
    expect(a).toEqual(b);
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
