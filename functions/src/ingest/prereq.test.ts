import { describe, it, expect } from "vitest";
import type { Concept } from "@tutor/shared";
import { inferPrerequisites } from "./prereq";

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
