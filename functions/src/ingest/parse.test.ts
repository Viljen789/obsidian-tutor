import { describe, it, expect } from "vitest";
import { parseNote, extractImageEmbeds } from "./parse";

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

  describe("inline Obsidian #tags", () => {
    it("extracts a real inline tag from the body", () => {
      const raw = "# Heading\n\nThis note is about #acid guarantees.";
      const note = parseNote("S/T.md", raw);
      expect(note.tags).toContain("acid");
    });

    it("treats a markdown heading (# then space) as NOT a tag", () => {
      const raw = "# Transactions\n\nNo inline tags here, just prose.";
      const note = parseNote("S/T.md", raw);
      // The heading word must not leak in as a tag.
      expect(note.tags).toEqual([]);
    });

    it("ignores a #tag that lives inside a fenced code block", () => {
      const raw = [
        "Intro with a real #exam tag.",
        "",
        "```bash",
        "# this is a shell comment, not a tag",
        "grep '#notatag' file",
        "```",
        "",
        "Outro.",
      ].join("\n");
      const note = parseNote("S/T.md", raw);
      expect(note.tags).toContain("exam");
      expect(note.tags).not.toContain("notatag");
      // The shell comment "# this is..." has a space after # so it isn't a tag
      // anyway, but the fenced region must be stripped regardless.
      expect(note.tags).not.toContain("this");
    });

    it("ignores a #tag inside an inline code span", () => {
      const raw = "Use the literal `#define` macro, and tag it #c-lang.";
      const note = parseNote("S/T.md", raw);
      expect(note.tags).toContain("c-lang");
      expect(note.tags).not.toContain("define");
    });

    it("supports nested tags like #a/b and dedupes against frontmatter", () => {
      const raw = [
        "---",
        "tags: [acid]",
        "---",
        "Nested #two-phase-locking/strict and a dup #acid reference.",
      ].join("\n");
      const note = parseNote("S/T.md", raw);
      expect(note.tags).toContain("two-phase-locking/strict");
      // "acid" came from frontmatter; the inline #acid must not duplicate it.
      expect(note.tags.filter((t) => t.toLowerCase() === "acid")).toHaveLength(1);
    });

    it("does not treat a bare number (#123) or mid-word # as a tag", () => {
      const raw = "See issue #123 and the url https://example.com/page#frag.";
      const note = parseNote("S/T.md", raw);
      expect(note.tags).toEqual([]);
    });

    it("merges frontmatter tags with inline tags, frontmatter first", () => {
      const raw = "---\ntags: [hardware]\n---\nBody mentions #cache and #latency.";
      const note = parseNote("S/T.md", raw);
      expect(note.tags).toEqual(["hardware", "cache", "latency"]);
    });
  });

  describe("image embeds", () => {
    it("captures Obsidian ![[img]] and ![[img|size]] embeds as written", () => {
      const raw = [
        "Intro ![[er-diagram.png]] and",
        "a sized one ![[img/cpu.png|200]].",
      ].join("\n");
      const note = parseNote("S/T.md", raw);
      expect(note.imageEmbeds).toEqual(["er-diagram.png", "img/cpu.png|200"]);
    });

    it("captures standard ![alt](path) only when the target is an image", () => {
      const raw = [
        "![an er diagram](img/er.png)",
        "[not an image](notes/page.md)",
        "![doc](files/spec.pdf)",
        "![cpu](./assets/cpu.jpeg)",
      ].join("\n");
      const note = parseNote("S/T.md", raw);
      // .md and .pdf targets are not image embeds; png/jpeg are.
      expect(note.imageEmbeds).toEqual(["img/er.png", "./assets/cpu.jpeg"]);
    });

    it("dedupes case-insensitively and preserves document order", () => {
      const raw = [
        "![[diagram.png]]",
        "![alt](img/CPU.png)",
        "![[diagram.png]]", // dup of the first
        "![again](IMG/cpu.png)", // dup of the second (case-insensitive)
      ].join("\n");
      const note = parseNote("S/T.md", raw);
      expect(note.imageEmbeds).toEqual(["diagram.png", "img/CPU.png"]);
    });

    it("ignores embeds inside fenced and inline code", () => {
      const raw = [
        "Real ![[real.png]] here.",
        "",
        "```md",
        "![[fenced.png]] and ![x](code.png) should be ignored",
        "```",
        "",
        "Inline `![[inline.png]]` ignored too.",
      ].join("\n");
      const note = parseNote("S/T.md", raw);
      expect(note.imageEmbeds).toEqual(["real.png"]);
    });

    it("supports a Markdown image with a title and angle-bracketed path", () => {
      const raw = '![alt](<img/my pic.png> "A title")';
      const note = parseNote("S/T.md", raw);
      expect(note.imageEmbeds).toEqual(["img/my pic.png"]);
    });

    it("recognises every supported image extension", () => {
      const exts = ["png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];
      const raw = exts.map((e, i) => `![a](img/file${i}.${e})`).join("\n");
      const note = parseNote("S/T.md", raw);
      expect(note.imageEmbeds).toEqual(exts.map((e, i) => `img/file${i}.${e}`));
    });

    it("leaves imageEmbeds empty when a note has none, and does not disturb wikilinks", () => {
      const raw = "Just prose linking [[Indexing]] and #atag, no images.";
      const note = parseNote("S/T.md", raw);
      expect(note.imageEmbeds).toEqual([]);
      expect(note.wikilinks).toEqual(["Indexing"]);
      expect(note.tags).toEqual(["atag"]);
    });
  });
});

describe("extractImageEmbeds (pure)", () => {
  it("interleaves Obsidian and Markdown embeds in document order", () => {
    const body = [
      "![md1](a.png)",
      "![[obs1.png]]",
      "![md2](b.svg)",
      "![[obs2.gif|x]]",
    ].join("\n");
    expect(extractImageEmbeds(body)).toEqual([
      "a.png",
      "obs1.png",
      "b.svg",
      "obs2.gif|x",
    ]);
  });

  it("returns [] for an empty body", () => {
    expect(extractImageEmbeds("")).toEqual([]);
  });
});
