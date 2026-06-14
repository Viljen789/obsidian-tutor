import { describe, it, expect } from "vitest";
import {
  parseRepoUrl,
  publicZipUrl,
  privateZipUrl,
  stripTopLevelDir,
  collectMarkdownEntries,
} from "./github";

describe("parseRepoUrl (pure)", () => {
  it("parses a plain https github URL", () => {
    expect(parseRepoUrl("https://github.com/octocat/Hello-World")).toEqual({
      owner: "octocat",
      repo: "Hello-World",
    });
  });

  it("strips a trailing .git suffix", () => {
    expect(parseRepoUrl("https://github.com/octocat/Hello-World.git")).toEqual({
      owner: "octocat",
      repo: "Hello-World",
    });
  });

  it("captures a /tree/<ref> branch", () => {
    expect(
      parseRepoUrl("https://github.com/octocat/Hello-World/tree/develop"),
    ).toEqual({ owner: "octocat", repo: "Hello-World", ref: "develop" });
  });

  it("captures a slash-containing ref from /tree/", () => {
    expect(
      parseRepoUrl("https://github.com/octocat/Hello-World/tree/feature/foo"),
    ).toEqual({ owner: "octocat", repo: "Hello-World", ref: "feature/foo" });
  });

  it("ignores query string and hash", () => {
    expect(
      parseRepoUrl("https://github.com/octocat/Hello-World?tab=readme#top"),
    ).toEqual({ owner: "octocat", repo: "Hello-World" });
  });

  it("tolerates a trailing slash", () => {
    expect(parseRepoUrl("https://github.com/octocat/Hello-World/")).toEqual({
      owner: "octocat",
      repo: "Hello-World",
    });
  });

  it("accepts a scheme-less github.com URL", () => {
    expect(parseRepoUrl("github.com/octocat/Hello-World")).toEqual({
      owner: "octocat",
      repo: "Hello-World",
    });
  });

  it("accepts a www. host", () => {
    expect(parseRepoUrl("https://www.github.com/octocat/Hello-World")).toEqual({
      owner: "octocat",
      repo: "Hello-World",
    });
  });

  it("rejects a non-github host", () => {
    expect(() => parseRepoUrl("https://gitlab.com/octocat/Hello-World")).toThrow(
      /github\.com/i,
    );
  });

  it("rejects a URL without a repo segment", () => {
    expect(() => parseRepoUrl("https://github.com/octocat")).toThrow(/repo/i);
  });

  it("rejects an empty / non-string input", () => {
    expect(() => parseRepoUrl("")).toThrow();
    // @ts-expect-error — exercising the runtime guard
    expect(() => parseRepoUrl(undefined)).toThrow();
  });
});

describe("archive URL builders (pure)", () => {
  it("builds the public codeload URL for a branch", () => {
    expect(publicZipUrl("octocat", "Hello-World", "main")).toBe(
      "https://codeload.github.com/octocat/Hello-World/zip/refs/heads/main",
    );
  });

  it("keeps slashes in a feature-branch ref but escapes other unsafe chars", () => {
    expect(publicZipUrl("o", "r", "feature/a b")).toBe(
      "https://codeload.github.com/o/r/zip/refs/heads/feature/a%20b",
    );
  });

  it("builds the private API zipball URL with a ref", () => {
    expect(privateZipUrl("octocat", "Hello-World", "develop")).toBe(
      "https://api.github.com/repos/octocat/Hello-World/zipball/develop",
    );
  });

  it("omits the ref segment when none is given (default branch)", () => {
    expect(privateZipUrl("octocat", "Hello-World")).toBe(
      "https://api.github.com/repos/octocat/Hello-World/zipball",
    );
  });
});

describe("stripTopLevelDir (pure)", () => {
  it("drops the wrapper folder segment", () => {
    expect(stripTopLevelDir("Hello-World-main/notes/Intro.md")).toBe(
      "notes/Intro.md",
    );
  });

  it("returns empty string for the wrapper directory entry itself", () => {
    expect(stripTopLevelDir("Hello-World-main/")).toBe("");
    expect(stripTopLevelDir("Hello-World-main")).toBe("");
  });

  it("handles backslash-separated names", () => {
    expect(stripTopLevelDir("repo-sha\\sub\\Note.md")).toBe("sub/Note.md");
  });
});

describe("collectMarkdownEntries (pure)", () => {
  // Helper: build a fake archive entry list (wrapper folder = "repo-main/").
  const entry = (name: string, content = "x", isDirectory = false) => ({
    entryName: `repo-main/${name}`,
    isDirectory,
    content,
  });

  it("keeps .md files and strips the wrapper folder from paths", () => {
    const out = collectMarkdownEntries([
      entry("Algorithms/BFS.md", "# BFS"),
      entry("README.md", "# readme"),
    ]);
    expect(out).toEqual([
      { path: "Algorithms/BFS.md", content: "# BFS" },
      { path: "README.md", content: "# readme" },
    ]);
  });

  it("skips non-markdown files", () => {
    const out = collectMarkdownEntries([
      entry("image.png"),
      entry("data.json"),
      entry("Note.md", "body"),
    ]);
    expect(out.map((e) => e.path)).toEqual(["Note.md"]);
  });

  it("skips dotfolders like .obsidian and dotfiles", () => {
    const out = collectMarkdownEntries([
      entry(".obsidian/workspace.md"),
      entry(".hidden.md"),
      entry("Visible.md", "ok"),
    ]);
    expect(out.map((e) => e.path)).toEqual(["Visible.md"]);
  });

  it("skips directory entries", () => {
    const out = collectMarkdownEntries([
      entry("Algorithms/", "", true),
      entry("Algorithms/BFS.md", "# BFS"),
    ]);
    expect(out.map((e) => e.path)).toEqual(["Algorithms/BFS.md"]);
  });

  it("scopes to a subdir and treats it as the vault root", () => {
    const out = collectMarkdownEntries(
      [
        entry("vault/Algorithms/BFS.md", "# BFS"),
        entry("vault/Index.md", "# index"),
        entry("docs/Other.md", "# other"), // outside the subdir
        entry("README.md", "# root readme"), // outside the subdir
      ],
      "vault",
    );
    expect(out).toEqual([
      { path: "Algorithms/BFS.md", content: "# BFS" },
      { path: "Index.md", content: "# index" },
    ]);
  });

  it("normalizes a subdir with surrounding slashes", () => {
    const out = collectMarkdownEntries(
      [entry("vault/Note.md", "n"), entry("Other.md", "o")],
      "/vault/",
    );
    expect(out.map((e) => e.path)).toEqual(["Note.md"]);
  });

  it("does not match a sibling folder that shares a subdir prefix", () => {
    // "vault" must not also capture "vault-archive/…".
    const out = collectMarkdownEntries(
      [entry("vault/A.md", "a"), entry("vault-archive/B.md", "b")],
      "vault",
    );
    expect(out.map((e) => e.path)).toEqual(["A.md"]);
  });

  it("returns empty when no markdown is present", () => {
    expect(
      collectMarkdownEntries([entry("img.png"), entry("style.css")]),
    ).toEqual([]);
  });
});
