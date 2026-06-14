import { describe, it, expect } from "vitest";
import { countNewlyIntroducedToday } from "./dailyCount";
import { newMastery } from "./mastery";
import type { Mastery, MasteryHistoryEntry } from "@tutor/shared";

const NOW = Date.UTC(2026, 5, 13, 12, 0, 0); // 2026-06-13 12:00 UTC
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ISO = (ms: number) => new Date(ms).toISOString();

function withHistory(conceptId: string, dates: number[]): Mastery {
  const history: MasteryHistoryEntry[] = dates.map((ms) => ({ date: ISO(ms), quality: 4 }));
  return { ...newMastery(conceptId), history };
}

describe("countNewlyIntroducedToday", () => {
  it("counts a concept whose first history entry is today", () => {
    const masteries = { a: withHistory("a", [NOW]) };
    expect(countNewlyIntroducedToday(masteries, NOW)).toBe(1);
  });

  it("ignores a concept introduced on a previous day, even if reviewed today", () => {
    const masteries = {
      a: withHistory("a", [NOW - 3 * MS_PER_DAY, NOW]), // first seen 3 days ago
    };
    expect(countNewlyIntroducedToday(masteries, NOW)).toBe(0);
  });

  it("ignores never-answered (no history) concepts", () => {
    const masteries = { a: newMastery("a") };
    expect(countNewlyIntroducedToday(masteries, NOW)).toBe(0);
  });

  it("counts only today's introductions across a mixed set", () => {
    const masteries = {
      a: withHistory("a", [NOW]), // today
      b: withHistory("b", [NOW - 5 * 60 * 1000]), // today, earlier
      c: withHistory("c", [NOW - 2 * MS_PER_DAY]), // two days ago
      d: newMastery("d"), // never answered
    };
    expect(countNewlyIntroducedToday(masteries, NOW)).toBe(2);
  });

  it("tolerates a malformed date string", () => {
    const masteries = {
      a: { ...newMastery("a"), history: [{ date: "not-a-date", quality: 3 }] },
    };
    expect(countNewlyIntroducedToday(masteries, NOW)).toBe(0);
  });
});
