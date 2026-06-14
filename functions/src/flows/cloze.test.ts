import { describe, it, expect } from "vitest";
import type { Flashcard } from "@tutor/shared";
import { extractClozeCards } from "./cloze";

const CID = "databases_indexing";

/**
 * Assert the deck has at least `n` cards and return it as a definitely-indexable
 * tuple. Keeps the tests strict under `noUncheckedIndexedAccess` without a sea of
 * non-null assertions — a failed expectation here is itself a useful test signal.
 */
function atLeast(cards: Flashcard[], n: number): Flashcard[] {
  expect(cards.length).toBeGreaterThanOrEqual(n);
  return cards;
}

/** The first card of a deck that must be non-empty. */
function only(cards: Flashcard[]): Flashcard {
  expect(cards).toHaveLength(1);
  const [card] = atLeast(cards, 1);
  return card as Flashcard;
}

describe("extractClozeCards — bolded-term extraction", () => {
  it("blanks the bolded term and puts it on the back", () => {
    const card = only(extractClozeCards(CID, "A **write-ahead log** keeps writes durable across a crash.", 4));

    expect(card.front).toBe("A ___ keeps writes durable across a crash.");
    expect(card.back).toBe("write-ahead log");
    expect(card.kind).toBe("cloze");
  });

  it("blanks EVERY occurrence of the term so the answer never leaks", () => {
    const card = only(extractClozeCards(CID, "An **index** is a structure; an index speeds up lookups.", 4));

    expect(card.front).toBe("An ___ is a structure; an ___ speeds up lookups.");
    expect(card.front).not.toMatch(/\bindex\b/i);
    expect(card.back).toBe("index");
  });

  it("picks the FIRST bolded term when a line has several", () => {
    const card = only(extractClozeCards(CID, "A **B-tree** stays balanced, unlike a naive **binary tree**.", 4));

    expect(card.back).toBe("B-tree");
    expect(card.front).toContain("binary tree"); // the other term survives intact
  });

  it("de-duplicates by answer term across lines", () => {
    const body = [
      "A **cache** stores hot data near the CPU.",
      "Later: a **cache** can go stale and serve old values.",
    ].join("\n");

    const card = only(extractClozeCards(CID, body, 8));
    expect(card.back).toBe("cache");
  });

  it("emits a soft length hint, never the term itself", () => {
    const card = only(extractClozeCards(CID, "A **mutex** guards a critical section.", 4));

    expect(card.hint).toBe("5 letters");
    expect(card.hint).not.toContain("mutex");
  });
});

describe("extractClozeCards — code & math are skipped", () => {
  it("ignores bolded text inside a fenced code block", () => {
    const body = [
      "```ts",
      "const x = **notBoldHere**; // a **fake** term inside code",
      "```",
      "A **transaction** is atomic.",
    ].join("\n");

    const card = only(extractClozeCards(CID, body, 8));
    expect(card.back).toBe("transaction");
  });

  it("ignores a $$ display-math block entirely", () => {
    const body = ["$$", "**E** = mc^2", "$$", "A **scalar** has magnitude but no direction."].join("\n");

    const card = only(extractClozeCards(CID, body, 8));
    expect(card.back).toBe("scalar");
  });

  it("skips a line containing inline display math ($$)", () => {
    expect(extractClozeCards(CID, "The **norm** is written $$\\|x\\|$$ in the notes.", 4)).toEqual([]);
  });

  it("skips headings, blockquotes, table rows, and wikilink-only lines", () => {
    const body = [
      "## A **heading** with a bold word",
      "> A **quoted** definition we skip.",
      "| **cell** | value |",
      "[[Indexing]]",
      "A **page** is the unit of disk I/O.",
    ].join("\n");

    const card = only(extractClozeCards(CID, body, 8));
    expect(card.back).toBe("page");
  });

  it("strips inline math from an otherwise minable sentence", () => {
    const card = only(
      extractClozeCards(CID, "The **gradient** $\\nabla f$ points uphill toward the steepest ascent.", 4),
    );

    expect(card.back).toBe("gradient");
    expect(card.front).not.toContain("$");
    expect(card.front).toContain("___");
  });
});

describe("extractClozeCards — empty / edge input → []", () => {
  it("returns [] for an empty body", () => {
    expect(extractClozeCards(CID, "", 4)).toEqual([]);
  });

  it("returns [] when there is no bolded term", () => {
    expect(extractClozeCards(CID, "Plain prose with no emphasis at all.", 4)).toEqual([]);
  });

  it("returns [] when max <= 0", () => {
    const body = "A **node** holds a value and pointers.";
    expect(extractClozeCards(CID, body, 0)).toEqual([]);
    expect(extractClozeCards(CID, body, -3)).toEqual([]);
  });

  it("returns [] for a bare bolded term with no surrounding context", () => {
    // "**X**." blanks to "___." — not enough context to be answerable.
    expect(extractClozeCards(CID, "**Acid**.", 4)).toEqual([]);
  });

  it("never throws on malformed / unterminated markdown", () => {
    const body = "An **unclosed bold and a ```dangling fence\nstill **valid** here.";
    expect(() => extractClozeCards(CID, body, 4)).not.toThrow();
  });

  it("ignores a term that is too long to be a fair blank", () => {
    const body = "**This entire long bolded clause is really a whole sentence on its own** yes.";
    expect(extractClozeCards(CID, body, 4)).toEqual([]);
  });
});

describe("extractClozeCards — ids, kind, and cap", () => {
  const body = [
    "A **heap** allocates at runtime.",
    "A **stack** grows and shrinks with calls.",
    "A **register** is the fastest storage.",
  ].join("\n");

  it("assigns stable, sequential ids and kind 'cloze'", () => {
    const cards = atLeast(extractClozeCards(CID, body, 8), 3);

    expect(cards.map((c) => c.id)).toEqual([
      `${CID}_fc_cloze_1`,
      `${CID}_fc_cloze_2`,
      `${CID}_fc_cloze_3`,
    ]);
    expect(cards.every((c) => c.kind === "cloze")).toBe(true);
    expect(cards.every((c) => c.conceptId === CID)).toBe(true);
  });

  it("preserves source order and respects the max cap", () => {
    const cards = atLeast(extractClozeCards(CID, body, 2), 2);

    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.back)).toEqual(["heap", "stack"]);
  });

  it("is deterministic — same input yields identical output", () => {
    const oneLine = "A **schema** describes the shape of the data in a table.";
    expect(extractClozeCards(CID, oneLine, 4)).toEqual(extractClozeCards(CID, oneLine, 4));
  });
});
