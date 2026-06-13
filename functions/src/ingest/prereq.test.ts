import { describe, it, expect } from "vitest";
import type { Concept } from "@tutor/shared";
import { inferPrerequisites, inferPrerequisitesWithMocs } from "./prereq";

function concept(partial: Partial<Concept> & { id: string }): Concept {
  return {
    id: partial.id,
    title: partial.title ?? partial.id,
    subject: partial.subject ?? "S",
    bodyMarkdown: partial.bodyMarkdown ?? "",
    tags: partial.tags ?? [],
    links: partial.links ?? [],
    prerequisites: [],
    sourcePath: partial.sourcePath ?? `S/${partial.id}.md`,
    importId: "i",
    createdAt: "t",
    updatedAt: "t",
  };
}

describe("inferPrerequisites (pure heuristic)", () => {
  it("orients each undirected edge from the more foundational concept to the dependent", () => {
    // 'advanced' links out to 'basic'; 'basic' is a leaf (no outgoing links) so
    // it is more foundational => prerequisite of 'advanced'.
    const concepts = [
      concept({ id: "advanced", links: ["basic"] }),
      concept({ id: "basic", links: [] }),
    ];
    const [advanced, basic] = inferPrerequisites(concepts);
    expect(advanced!.prerequisites).toEqual(["basic"]);
    expect(basic!.prerequisites).toEqual([]);
  });

  it("uses path depth as a tie-breaker when outgoing-link counts match", () => {
    const concepts = [
      concept({ id: "deep", links: ["shallow"], sourcePath: "S/sub/deep.md" }),
      concept({ id: "shallow", links: ["deep"], sourcePath: "S/shallow.md" }),
    ];
    const result = inferPrerequisites(concepts);
    const deep = result.find((c) => c.id === "deep")!;
    const shallow = result.find((c) => c.id === "shallow")!;
    // shallower path => more foundational => prerequisite of the deeper note.
    expect(deep.prerequisites).toContain("shallow");
    expect(shallow.prerequisites).not.toContain("deep");
  });

  it("is deterministic and never self-references or creates 2-cycles", () => {
    const concepts = [
      concept({ id: "a", links: ["b", "c"] }),
      concept({ id: "b", links: ["a"] }),
      concept({ id: "c", links: [] }),
    ];
    const first = inferPrerequisites(concepts);
    const second = inferPrerequisites(concepts);
    expect(first).toEqual(second); // deterministic
    for (const c of first) {
      expect(c.prerequisites).not.toContain(c.id);
      for (const p of c.prerequisites) {
        const other = first.find((x) => x.id === p)!;
        expect(other.prerequisites).not.toContain(c.id);
      }
    }
  });

  it("ignores links to non-existent concepts", () => {
    const concepts = [concept({ id: "a", links: ["ghost"] })];
    const [a] = inferPrerequisites(concepts);
    expect(a!.prerequisites).toEqual([]);
  });
});

describe("inferPrerequisitesWithMocs (MOC-aware ordering)", () => {
  const find = (cs: Concept[], id: string) => cs.find((c) => c.id === id)!;

  it("treats a concept listed EARLIER in a MOC as a prerequisite of LATER ones", () => {
    // A "Databases MOC" lists first -> second -> third as the learning order.
    const concepts = [
      concept({
        id: "moc",
        title: "Databases MOC",
        subject: "Databases",
        sourcePath: "Databases/Databases MOC.md",
        links: ["first", "second", "third"], // authored order
      }),
      concept({ id: "first", subject: "Databases", sourcePath: "Databases/first.md" }),
      concept({ id: "second", subject: "Databases", sourcePath: "Databases/second.md" }),
      concept({ id: "third", subject: "Databases", sourcePath: "Databases/third.md" }),
    ];

    const result = inferPrerequisitesWithMocs(concepts);
    // Full ordering (not just adjacent): later concepts depend on ALL earlier ones.
    expect(find(result, "second").prerequisites).toContain("first");
    expect(find(result, "third").prerequisites).toEqual(
      expect.arrayContaining(["first", "second"]),
    );
    // And never the reverse direction.
    expect(find(result, "first").prerequisites).not.toContain("second");
    expect(find(result, "first").prerequisites).not.toContain("third");
    expect(find(result, "second").prerequisites).not.toContain("third");
    // The MOC note itself is not a prerequisite of anything (it's an index).
    for (const c of result) expect(c.prerequisites).not.toContain("moc");
  });

  it("takes PRECEDENCE over the structural heuristic for an ordered pair", () => {
    // Heuristic alone: `early` has more outgoing links than `late`, so the
    // heuristic would call `late` the foundation (prereq of `early`).
    const concepts = [
      concept({
        id: "early",
        subject: "S",
        sourcePath: "S/early.md",
        links: ["late", "extra"], // 2 outgoing -> looks LESS foundational
      }),
      concept({
        id: "late",
        subject: "S",
        sourcePath: "S/late.md",
        links: ["early"], // 1 outgoing -> heuristic foundation
      }),
      concept({ id: "extra", subject: "S", sourcePath: "S/extra.md", links: ["early"] }),
      concept({
        id: "moc",
        title: "S MOC",
        subject: "S",
        sourcePath: "S/S MOC.md",
        links: ["early", "late"], // authored: early BEFORE late
      }),
    ];

    // Sanity: the bare heuristic orients the pair late -> early.
    const heur = inferPrerequisites(concepts);
    expect(find(heur, "early").prerequisites).toContain("late");
    expect(find(heur, "late").prerequisites).not.toContain("early");

    // MOC flips it: early is now the prerequisite of late, and the opposite
    // heuristic edge is removed.
    const moc = inferPrerequisitesWithMocs(concepts);
    expect(find(moc, "late").prerequisites).toContain("early");
    expect(find(moc, "early").prerequisites).not.toContain("late");
  });

  it("only orders concepts that share the MOC's subject", () => {
    const concepts = [
      concept({
        id: "moc",
        title: "Databases MOC",
        subject: "Databases",
        sourcePath: "Databases/Databases MOC.md",
        links: ["db1", "foreign"], // foreign lives in another subject
      }),
      concept({ id: "db1", subject: "Databases", sourcePath: "Databases/db1.md" }),
      concept({ id: "foreign", subject: "Networking", sourcePath: "Networking/foreign.md" }),
    ];
    const result = inferPrerequisitesWithMocs(concepts);
    // Cross-subject target is skipped: no edge in either direction.
    expect(find(result, "foreign").prerequisites).not.toContain("db1");
    expect(find(result, "db1").prerequisites).not.toContain("foreign");
  });

  it("does not match substrings like 'mocha' as a MOC note", () => {
    // "Mocha" must NOT be treated as a Map of Content.
    const concepts = [
      concept({
        id: "mocha",
        title: "Mocha Testing",
        subject: "S",
        sourcePath: "S/Mocha Testing.md",
        links: ["a", "b"],
      }),
      concept({ id: "a", subject: "S", sourcePath: "S/a.md" }),
      concept({ id: "b", subject: "S", sourcePath: "S/b.md" }),
    ];
    // No real MOC present => identical to the bare heuristic.
    expect(inferPrerequisitesWithMocs(concepts)).toEqual(inferPrerequisites(concepts));
  });

  it("is a no-op (identical to the heuristic) when the vault has no MOC notes", () => {
    const concepts = [
      concept({ id: "advanced", subject: "S", links: ["basic"] }),
      concept({ id: "basic", subject: "S", links: [] }),
      concept({ id: "c", subject: "S", links: ["advanced", "basic"] }),
    ];
    expect(inferPrerequisitesWithMocs(concepts)).toEqual(inferPrerequisites(concepts));
  });

  it("is deterministic and introduces no self-prerequisites", () => {
    const concepts = [
      concept({
        id: "moc",
        title: "S MOC",
        subject: "S",
        sourcePath: "S/S MOC.md",
        links: ["x", "y", "z"],
      }),
      concept({ id: "x", subject: "S", sourcePath: "S/x.md" }),
      concept({ id: "y", subject: "S", sourcePath: "S/y.md" }),
      concept({ id: "z", subject: "S", sourcePath: "S/z.md" }),
    ];
    const a = inferPrerequisitesWithMocs(concepts);
    const b = inferPrerequisitesWithMocs(concepts);
    expect(a).toEqual(b);
    for (const c of a) expect(c.prerequisites).not.toContain(c.id);
  });
});
