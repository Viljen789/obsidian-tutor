/**
 * Phase 5 integration test — the adaptive *brain* end to end on the REAL sample
 * vault. Ingests the on-disk vault through the pure pipeline (parse → graph →
 * prereq) and drives the engine's sequencer + mastery update across the four
 * behaviours the product promises:
 *
 *   1. fresh learner is taught a foundational concept (deep depth),
 *   2. a concept is GATED behind its prerequisites until they're mastered,
 *   3. a due review takes priority over learning something new,
 *   4. a graded answer advances mastery and reschedules (strong lengthens,
 *      weak resets to ~1 day), and the just-seen concept isn't re-served.
 *
 * Deterministic (fixed `nowMs`), no Firestore, no API key. This is the loop the
 * live app runs — proven here on real data so Phase 5 doesn't rest on mocks.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_USER_SETTINGS,
  type Concept,
  type Mastery,
} from "@tutor/shared";
import { parseNote, assembleGraphWithWarnings, inferPrerequisites } from "../ingest/index";
import { applyGrade, newMastery, selectNextItem } from "../engine/index";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = path.resolve(HERE, "../../../sample-vault");
const NOW = Date.parse("2026-06-13T12:00:00.000Z");
const DAY = 86_400_000;
const settings = DEFAULT_USER_SETTINGS;

function collectMarkdown(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectMarkdown(full, root));
    else if (entry.toLowerCase().endsWith(".md"))
      out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out;
}

/** A mastery doc with overrides on top of a fresh one. */
function mastery(conceptId: string, over: Partial<Mastery>): Mastery {
  return { ...newMastery(conceptId), ...over };
}
const mastered = (id: string): Mastery =>
  mastery(id, { status: "mastered", masteryScore: 0.9, repetitions: 3 });

let concepts: Concept[];
let byId: Map<string, Concept>;

beforeAll(() => {
  const notes = collectMarkdown(VAULT_DIR).map((rel) =>
    parseNote(rel, readFileSync(path.join(VAULT_DIR, rel), "utf8")),
  );
  const { concepts: base } = assembleGraphWithWarnings(notes, "phase5", "2026-06-13T00:00:00.000Z");
  concepts = inferPrerequisites(base);
  byId = new Map(concepts.map((c) => [c.id, c]));
});

describe("adaptive loop on the real sample vault", () => {
  it("1. teaches a fresh learner a foundational concept, at deep depth", () => {
    const next = selectNextItem({ concepts, masteries: {}, nowMs: NOW, settings });
    expect(next.action).toBe("learn");
    const picked = byId.get(next.conceptId!)!;
    // With no mastery yet, only a concept whose prerequisites are all satisfied
    // (i.e. it has none) can be unlocked.
    expect(picked.prerequisites).toHaveLength(0);
    expect(next.suggestedDepth).toBe("deep");
  });

  it("2. GATES a concept behind its prerequisites until they're mastered", () => {
    const dependent = concepts.find((c) => c.prerequisites.length > 0)!;
    const prereqs = new Set(dependent.prerequisites);

    // Everything except the dependent is accounted for: its prereqs sit BELOW
    // the mastery threshold (learning, not new, not due); all others are mastered.
    // So the only "new" concept is the dependent — and it must stay blocked.
    const masteries: Record<string, Mastery> = {};
    for (const c of concepts) {
      if (c.id === dependent.id) continue; // left absent ⇒ treated as new
      masteries[c.id] = prereqs.has(c.id)
        ? mastery(c.id, { status: "learning", masteryScore: 0.3, repetitions: 1 })
        : mastered(c.id);
    }

    const gated = selectNextItem({ concepts, masteries, nowMs: NOW, settings });
    expect(gated.action).toBe("none");
    expect(gated.blocked?.some((b) => b.conceptId === dependent.id)).toBe(true);

    // Now master the prerequisites — the dependent unlocks and is taught next.
    for (const pid of dependent.prerequisites) masteries[pid] = mastered(pid);
    const unlocked = selectNextItem({ concepts, masteries, nowMs: NOW, settings });
    expect(unlocked.action).toBe("learn");
    expect(unlocked.conceptId).toBe(dependent.id);
  });

  it("3. prioritizes a due review over learning something new", () => {
    const due = concepts[0]!;
    const masteries: Record<string, Mastery> = {
      [due.id]: mastery(due.id, {
        status: "review",
        masteryScore: 0.5,
        repetitions: 1,
        intervalDays: 3,
        lastReviewed: new Date(NOW - 7 * DAY).toISOString(),
        dueDate: new Date(NOW - DAY).toISOString(), // overdue
      }),
    };
    const next = selectNextItem({ concepts, masteries, nowMs: NOW, settings });
    expect(next.action).toBe("review");
    expect(next.conceptId).toBe(due.id);
  });

  it("4. advances mastery on a graded answer and reschedules correctly", () => {
    const foundational = concepts.find((c) => c.prerequisites.length === 0)!;

    // Strong answer: mastery rises, status leaves "new", due date moves forward.
    const strong = applyGrade(newMastery(foundational.id), 5, 0.95, NOW);
    expect(strong.masteryScore).toBeGreaterThan(0);
    expect(strong.status).not.toBe("new");
    expect(strong.dueDate).not.toBeNull();
    expect(Date.parse(strong.dueDate!)).toBeGreaterThan(NOW);

    // The just-seen concept isn't immediately re-served (not new, not due).
    const after = selectNextItem({
      concepts,
      masteries: { [foundational.id]: strong },
      nowMs: NOW,
      settings,
    });
    if (after.action === "learn") expect(after.conceptId).not.toBe(foundational.id);

    // Weak answer resets the interval to ~1 day.
    const weak = applyGrade(newMastery(foundational.id), 1, 0.1, NOW);
    expect(weak.intervalDays).toBe(1);
    expect(Math.round((Date.parse(weak.dueDate!) - NOW) / DAY)).toBe(1);
  });
});
