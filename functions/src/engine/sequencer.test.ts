import { describe, it, expect } from "vitest";
import { selectNextItem } from "./sequencer";
import { newMastery } from "./mastery";
import { DEFAULT_USER_SETTINGS, type Concept, type Mastery } from "@tutor/shared";

const NOW = Date.UTC(2026, 5, 13, 12, 0, 0);
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ISO = (ms: number) => new Date(ms).toISOString();

function concept(id: string, over: Partial<Concept> = {}): Concept {
  return {
    id,
    title: id,
    subject: "Databases",
    bodyMarkdown: "",
    tags: [],
    links: [],
    prerequisites: [],
    sourcePath: `${id}.md`,
    importId: "imp1",
    createdAt: ISO(NOW),
    updatedAt: ISO(NOW),
    ...over,
  };
}

/** A mastery entry with sensible scheduled defaults, overridable per-field. */
function mastery(conceptId: string, over: Partial<Mastery> = {}): Mastery {
  return { ...newMastery(conceptId), ...over };
}

describe("selectNextItem — due-review priority", () => {
  it("a due review beats an available new concept", () => {
    const concepts = [concept("a"), concept("b")];
    const masteries: Record<string, Mastery> = {
      a: mastery("a", {
        status: "review",
        masteryScore: 0.7,
        repetitions: 2,
        dueDate: ISO(NOW - MS_PER_DAY), // overdue by a day
      }),
      // b has no mastery entry → treated as new and available.
    };
    const out = selectNextItem({ concepts, masteries, nowMs: NOW, settings: DEFAULT_USER_SETTINGS });
    expect(out.action).toBe("review");
    expect(out.conceptId).toBe("a");
  });

  it("picks the MOST overdue concept when several are due", () => {
    const concepts = [concept("a"), concept("b"), concept("c")];
    const masteries: Record<string, Mastery> = {
      a: mastery("a", { status: "review", dueDate: ISO(NOW - 1 * MS_PER_DAY) }),
      b: mastery("b", { status: "review", dueDate: ISO(NOW - 5 * MS_PER_DAY) }), // most overdue
      c: mastery("c", { status: "review", dueDate: ISO(NOW - 2 * MS_PER_DAY) }),
    };
    const out = selectNextItem({ concepts, masteries, nowMs: NOW, settings: DEFAULT_USER_SETTINGS });
    expect(out.conceptId).toBe("b");
  });

  it("a concept due exactly now (dueDate == now) is reviewed", () => {
    const concepts = [concept("a")];
    const masteries = { a: mastery("a", { status: "review", dueDate: ISO(NOW) }) };
    const out = selectNextItem({ concepts, masteries, nowMs: NOW, settings: DEFAULT_USER_SETTINGS });
    expect(out.action).toBe("review");
  });

  it("a concept due in the future is NOT reviewed yet", () => {
    const concepts = [concept("a")];
    const masteries = {
      a: mastery("a", { status: "review", masteryScore: 0.9, dueDate: ISO(NOW + MS_PER_DAY) }),
    };
    const out = selectNextItem({ concepts, masteries, nowMs: NOW, settings: DEFAULT_USER_SETTINGS });
    expect(out.action).not.toBe("review");
  });
});

describe("selectNextItem — prerequisite gating", () => {
  it("gates a new concept until ALL prerequisites reach the threshold", () => {
    // adv requires base; base mastery is below threshold (0.6) → adv is blocked.
    const concepts = [concept("base"), concept("adv", { prerequisites: ["base"] })];
    const masteries: Record<string, Mastery> = {
      base: mastery("base", { status: "review", masteryScore: 0.5, dueDate: ISO(NOW + MS_PER_DAY) }),
    };
    const out = selectNextItem({ concepts, masteries, nowMs: NOW, settings: DEFAULT_USER_SETTINGS });
    expect(out.action).toBe("none");
    expect(out.blocked).toEqual([{ conceptId: "adv", missingPrereqs: ["base"] }]);
  });

  it("unlocks the new concept once every prerequisite is at/above threshold", () => {
    const concepts = [
      concept("base"),
      concept("adv", { prerequisites: ["base"], title: "Advanced" }),
    ];
    const masteries: Record<string, Mastery> = {
      // base satisfied (>= 0.6) and not due, so it won't be picked for review.
      base: mastery("base", { status: "review", masteryScore: 0.8, dueDate: ISO(NOW + MS_PER_DAY) }),
    };
    const out = selectNextItem({ concepts, masteries, nowMs: NOW, settings: DEFAULT_USER_SETTINGS });
    expect(out.action).toBe("learn");
    expect(out.conceptId).toBe("adv");
  });

  it("reports only the unmet prerequisites for a multi-prereq concept", () => {
    // Only `adv` is new; p1/p2 are in-progress (not new) so they won't be
    // auto-selected to learn. p1 clears the threshold, p2 does not.
    const concepts = [
      concept("p1"),
      concept("p2"),
      concept("adv", { prerequisites: ["p1", "p2"] }),
    ];
    const masteries: Record<string, Mastery> = {
      p1: mastery("p1", { status: "review", masteryScore: 0.9, dueDate: ISO(NOW + MS_PER_DAY) }),
      p2: mastery("p2", { status: "learning", masteryScore: 0.4, dueDate: ISO(NOW + MS_PER_DAY) }),
    };
    const out = selectNextItem({ concepts, masteries, nowMs: NOW, settings: DEFAULT_USER_SETTINGS });
    expect(out.action).toBe("none");
    // p1 is satisfied; only p2 remains as a missing prerequisite of adv.
    expect(out.blocked).toEqual([{ conceptId: "adv", missingPrereqs: ["p2"] }]);
  });

  it("a concept with no prerequisites is immediately learnable", () => {
    const out = selectNextItem({
      concepts: [concept("solo", { title: "Solo" })],
      masteries: {},
      nowMs: NOW,
      settings: DEFAULT_USER_SETTINGS,
    });
    expect(out.action).toBe("learn");
    expect(out.conceptId).toBe("solo");
  });
});

describe("selectNextItem — daily new-concept cap", () => {
  it("does not introduce a new concept once the daily limit is hit", () => {
    const out = selectNextItem({
      concepts: [concept("a")],
      masteries: {},
      nowMs: NOW,
      settings: { ...DEFAULT_USER_SETTINGS, dailyNewLimit: 3 },
      newlyIntroducedToday: 3,
    });
    expect(out.action).toBe("none");
    expect(out.reason).toMatch(/limit/i);
  });

  it("still introduces a new concept below the daily limit", () => {
    const out = selectNextItem({
      concepts: [concept("a")],
      masteries: {},
      nowMs: NOW,
      settings: { ...DEFAULT_USER_SETTINGS, dailyNewLimit: 3 },
      newlyIntroducedToday: 2,
    });
    expect(out.action).toBe("learn");
  });

  it("a due review is served even after the daily new-cap is reached", () => {
    const concepts = [concept("due"), concept("fresh")];
    const masteries = {
      due: mastery("due", { status: "review", dueDate: ISO(NOW - MS_PER_DAY) }),
    };
    const out = selectNextItem({
      concepts,
      masteries,
      nowMs: NOW,
      settings: { ...DEFAULT_USER_SETTINGS, dailyNewLimit: 1 },
      newlyIntroducedToday: 1,
    });
    expect(out.action).toBe("review");
    expect(out.conceptId).toBe("due");
  });
});

describe("selectNextItem — 'none' outcome", () => {
  it("returns action 'none' with an empty blocked list when all is mastered & not due", () => {
    const concepts = [concept("a")];
    const masteries = {
      a: mastery("a", { status: "mastered", masteryScore: 0.95, dueDate: ISO(NOW + 10 * MS_PER_DAY) }),
    };
    const out = selectNextItem({ concepts, masteries, nowMs: NOW, settings: DEFAULT_USER_SETTINGS });
    expect(out.action).toBe("none");
    expect(out.conceptId).toBeNull();
    expect(out.blocked).toEqual([]);
  });
});

describe("selectNextItem — suggestedDepth adapts to mastery", () => {
  it("new/weak concept → deep", () => {
    const out = selectNextItem({
      concepts: [concept("a")],
      masteries: {},
      nowMs: NOW,
      settings: DEFAULT_USER_SETTINGS,
    });
    expect(out.suggestedDepth).toBe("deep");
  });

  it("mid mastery on a due review → standard", () => {
    const concepts = [concept("a")];
    const masteries = {
      a: mastery("a", { status: "review", masteryScore: 0.6, dueDate: ISO(NOW - MS_PER_DAY) }),
    };
    const out = selectNextItem({ concepts, masteries, nowMs: NOW, settings: DEFAULT_USER_SETTINGS });
    expect(out.suggestedDepth).toBe("standard");
  });

  it("high mastery on a due review → refresher", () => {
    const concepts = [concept("a")];
    const masteries = {
      a: mastery("a", { status: "mastered", masteryScore: 0.92, dueDate: ISO(NOW - MS_PER_DAY) }),
    };
    const out = selectNextItem({ concepts, masteries, nowMs: NOW, settings: DEFAULT_USER_SETTINGS });
    expect(out.suggestedDepth).toBe("refresher");
  });
});

describe("selectNextItem — subject filter", () => {
  it("only considers concepts in the requested subject", () => {
    const concepts = [
      concept("db1", { subject: "Databases", title: "DB One" }),
      concept("algo1", { subject: "Algorithms", title: "Algo One" }),
    ];
    const out = selectNextItem({
      concepts,
      masteries: {},
      nowMs: NOW,
      settings: DEFAULT_USER_SETTINGS,
      subject: "Algorithms",
    });
    expect(out.action).toBe("learn");
    expect(out.conceptId).toBe("algo1");
  });

  it("ignores a due review outside the requested subject", () => {
    const concepts = [
      concept("dbDue", { subject: "Databases" }),
      concept("algoNew", { subject: "Algorithms" }),
    ];
    const masteries = {
      dbDue: mastery("dbDue", { status: "review", dueDate: ISO(NOW - MS_PER_DAY) }),
    };
    const out = selectNextItem({
      concepts,
      masteries,
      nowMs: NOW,
      settings: DEFAULT_USER_SETTINGS,
      subject: "Algorithms",
    });
    expect(out.action).toBe("learn");
    expect(out.conceptId).toBe("algoNew");
  });
});

describe("selectNextItem — manual prerequisite override", () => {
  it("a manual override REPLACES inferred prerequisites (can unblock)", () => {
    // a is in progress (unmastered) but not a NEW candidate; without the override
    // b would be blocked by its inferred prereq a. The empty override clears it.
    const concepts = [
      concept("a"),
      concept("b", { prerequisites: ["a"], manualPrerequisites: [] }),
    ];
    const masteries = {
      a: mastery("a", { status: "learning", masteryScore: 0.2, dueDate: null }),
    };
    const out = selectNextItem({ concepts, masteries, nowMs: NOW, settings: DEFAULT_USER_SETTINGS });
    expect(out.action).toBe("learn");
    expect(out.conceptId).toBe("b");
  });

  it("a manual override can ADD a gate inference missed", () => {
    const concepts = [
      concept("a"),
      concept("c", { prerequisites: [], manualPrerequisites: ["a"] }),
    ];
    // a unmastered + in progress; c's manual prereq a now gates it.
    const blocked = selectNextItem({
      concepts,
      masteries: { a: mastery("a", { status: "learning", masteryScore: 0.2, dueDate: null }) },
      nowMs: NOW,
      settings: DEFAULT_USER_SETTINGS,
    });
    expect(blocked.action).toBe("none");
    expect(blocked.blocked?.some((b) => b.conceptId === "c")).toBe(true);

    // Master a → c unlocks.
    const unlocked = selectNextItem({
      concepts,
      masteries: { a: mastery("a", { status: "mastered", masteryScore: 0.9, dueDate: null }) },
      nowMs: NOW,
      settings: DEFAULT_USER_SETTINGS,
    });
    expect(unlocked.action).toBe("learn");
    expect(unlocked.conceptId).toBe("c");
  });
});
