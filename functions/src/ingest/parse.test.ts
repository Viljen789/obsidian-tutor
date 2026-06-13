import { describe, it, expect } from "vitest";
import { parseNote } from "./parse";

describe("parseNote (pure)", () => {
  it("reads title/subject/tags from frontmatter and strips it from the body", () => {
    const raw = [
      "---",
      "title: CPU Registers",
      "subject: Low-Level Programming",
      "tags: [cpu, hardware]",
      "---",
      "",
      "# CPU Registers",
      "",
      "Body references [[Memory Layout]].",
      "",
    ].join("\n");

    const note = parseNote("Low-Level Programming/Registers.md", raw);

    expect(note.title).toBe("CPU Registers");
    expect(note.subject).toBe("Low-Level Programming");
    expect(note.tags).toEqual(["cpu", "hardware"]);
    expect(note.bodyMarkdown).toContain("# CPU Registers");
    expect(note.bodyMarkdown).not.toContain("title:");
    expect(note.frontmatter.title).toBe("CPU Registers");
  });

  it("falls back to filename for title and top-level folder for subject", () => {
    const raw = "# Query Planner\n\nNo frontmatter here, links [[Indexing]].";
    const note = parseNote("Databases/Query Planner.md", raw);

    expect(note.title).toBe("Query Planner");
    expect(note.subject).toBe("Databases");
    expect(note.tags).toEqual([]);
    expect(note.frontmatter).toEqual({});
  });

  it("extracts wikilink targets for plain / aliased / heading forms", () => {
    const raw = [
      "Plain [[Memory Layout]],",
      "aliased [[Indexing|good indexes]],",
      "heading [[Transactions#Isolation]],",
      "and [[Stack vs Heap#frames|the stack]].",
      "Duplicate [[Memory Layout]] is deduped.",
    ].join("\n");

    const note = parseNote("Misc/Sample.md", raw);

    // Order-preserving, deduped, alias + heading stripped.
    expect(note.wikilinks).toEqual([
      "Memory Layout",
      "Indexing",
      "Transactions",
      "Stack vs Heap",
    ]);
  });

  it("normalizes a comma/space separated inline tag string", () => {
    const raw = "---\ntitle: T\ntags: alpha, beta gamma\n---\nbody";
    const note = parseNote("S/T.md", raw);
    expect(note.tags).toEqual(["alpha", "beta", "gamma"]);
  });
});
