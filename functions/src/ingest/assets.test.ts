/**
 * Unit tests for the PURE parts of asset handling: embed-name normalisation,
 * extension/content-type derivation, Storage path construction, the tokenized
 * download-URL scheme, and the (pure) basename-keyed lookup + concept attach.
 *
 * No Storage / network here — `uploadVaultAssets` is exercised live by the
 * orchestrator. `attachAssetsToConcepts` is pure (mutates plain objects), so it
 * is safe and valuable to cover here.
 */
import { describe, it, expect } from "vitest";
import type { Concept } from "@tutor/shared";
import {
  imageExtensions,
  normaliseAssetName,
  assetExtension,
  contentTypeFor,
  safeAssetFileName,
  assetStoragePrefix,
  assetObjectPath,
  tokenizedUrl,
  buildAssetLookup,
  attachAssetsToConcepts,
} from "./assets";
import type { ParsedNote } from "./index";

/** Minimal ParsedNote builder for attach tests. */
function note(sourcePath: string, imageEmbeds: string[]): ParsedNote {
  return {
    sourcePath,
    title: sourcePath,
    subject: "S",
    tags: [],
    bodyMarkdown: "",
    wikilinks: [],
    imageEmbeds,
    frontmatter: {},
  };
}

/** Minimal Concept builder for attach tests. */
function concept(sourcePath: string): Concept {
  return {
    id: sourcePath,
    title: sourcePath,
    subject: "S",
    bodyMarkdown: "",
    tags: [],
    links: [],
    prerequisites: [],
    sourcePath,
    importId: "imp",
    createdAt: "2026-06-13T00:00:00.000Z",
    updatedAt: "2026-06-13T00:00:00.000Z",
  };
}

describe("imageExtensions", () => {
  it("covers the documented image formats", () => {
    expect([...imageExtensions]).toEqual([
      "png",
      "jpg",
      "jpeg",
      "gif",
      "svg",
      "webp",
      "avif",
    ]);
  });
});

describe("normaliseAssetName", () => {
  it("lowercases and strips directory prefixes", () => {
    expect(normaliseAssetName("img/ER-Diagram.PNG")).toBe("er-diagram.png");
    expect(normaliseAssetName("assets/sub/CPU.png")).toBe("cpu.png");
  });

  it("drops an Obsidian |alias / |size suffix", () => {
    expect(normaliseAssetName("er-diagram.png|200")).toBe("er-diagram.png");
    expect(normaliseAssetName("img/cpu.png|300x200")).toBe("cpu.png");
  });

  it("drops query/hash and normalises backslashes", () => {
    expect(normaliseAssetName("cpu.png?v=2")).toBe("cpu.png");
    expect(normaliseAssetName("cpu.png#frag")).toBe("cpu.png");
    expect(normaliseAssetName("img\\windows\\cpu.png")).toBe("cpu.png");
  });

  it("collapses different references to the same matchable basename", () => {
    const refs = ["er-diagram.png", "img/er-diagram.png", "./img/er-diagram.png|200"];
    const keys = new Set(refs.map(normaliseAssetName));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("er-diagram.png");
  });
});

describe("assetExtension / contentTypeFor", () => {
  it("derives the lowercased extension", () => {
    expect(assetExtension("img/Photo.JPG")).toBe("jpg");
    expect(assetExtension("diagram.svg|x")).toBe("svg");
    expect(assetExtension("noext")).toBe("");
  });

  it("maps extensions to content types, octet-stream for unknown", () => {
    expect(contentTypeFor("a.png")).toBe("image/png");
    expect(contentTypeFor("a.jpg")).toBe("image/jpeg");
    expect(contentTypeFor("a.jpeg")).toBe("image/jpeg");
    expect(contentTypeFor("a.gif")).toBe("image/gif");
    expect(contentTypeFor("a.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("a.webp")).toBe("image/webp");
    expect(contentTypeFor("a.avif")).toBe("image/avif");
    expect(contentTypeFor("a.bin")).toBe("application/octet-stream");
  });
});

describe("safeAssetFileName", () => {
  it("keeps a clean basename intact", () => {
    expect(safeAssetFileName("er-diagram.png")).toBe("er-diagram.png");
  });

  it("collapses unsafe characters and spaces to dashes", () => {
    expect(safeAssetFileName("My Diagram (v2).png")).toBe("my-diagram-v2-.png");
    expect(safeAssetFileName("img/space name.jpg")).toBe("space-name.jpg");
  });

  it("never returns an empty name", () => {
    expect(safeAssetFileName("???")).toBe("asset");
  });
});

describe("Storage paths", () => {
  it("builds a per-import asset prefix", () => {
    expect(assetStoragePrefix("u1", "imp9")).toBe("users/u1/vault-assets/imp9");
  });

  it("builds a full object path with a safe filename", () => {
    expect(assetObjectPath("u1", "imp9", "img/ER Diagram.png")).toBe(
      "users/u1/vault-assets/imp9/er-diagram.png",
    );
  });
});

describe("tokenizedUrl", () => {
  it("builds a Firebase download URL with the path fully URI-encoded", () => {
    const url = tokenizedUrl(
      "demo-tutor.appspot.com",
      "users/u1/vault-assets/imp9/er-diagram.png",
      "tok-123",
    );
    expect(url).toBe(
      "https://firebasestorage.googleapis.com/v0/b/demo-tutor.appspot.com/o/" +
        "users%2Fu1%2Fvault-assets%2Fimp9%2Fer-diagram.png?alt=media&token=tok-123",
    );
  });

  it("encodes slashes as %2F (object addressed as a single path segment)", () => {
    const url = tokenizedUrl("b", "a/b/c.png", "t");
    expect(url).toContain("/o/a%2Fb%2Fc.png?");
    expect(url).not.toContain("/o/a/b/c.png");
  });
});

describe("buildAssetLookup (pure)", () => {
  it("resolves an embed reference to bytes by basename, case-insensitively", () => {
    const lookup = buildAssetLookup([
      { name: "attachments/ER-Diagram.png", data: () => Buffer.from("png-bytes") },
    ]);
    // Referenced as written with a different path + case + size suffix.
    expect(lookup("img/er-diagram.png|200")?.toString()).toBe("png-bytes");
    expect(lookup("er-diagram.PNG")?.toString()).toBe("png-bytes");
  });

  it("returns null for an unknown reference", () => {
    const lookup = buildAssetLookup([
      { name: "cpu.png", data: () => Buffer.from("x") },
    ]);
    expect(lookup("missing.png")).toBeNull();
  });

  it("is deterministic on basename collisions (first archive entry wins)", () => {
    const lookup = buildAssetLookup([
      { name: "a/cpu.png", data: () => Buffer.from("first") },
      { name: "b/cpu.png", data: () => Buffer.from("second") },
    ]);
    expect(lookup("cpu.png")?.toString()).toBe("first");
  });
});

describe("attachAssetsToConcepts (pure)", () => {
  it("attaches { name (as written), url } for embeds that resolved, in order", () => {
    const notes = [note("S/A.md", ["er-diagram.png", "img/cpu.png|200"])];
    const concepts = [concept("S/A.md")];
    const urls = new Map([
      ["er-diagram.png", "https://x/er"],
      ["cpu.png", "https://x/cpu"],
    ]);

    attachAssetsToConcepts(concepts, notes, urls);

    expect(concepts[0]!.assets).toEqual([
      { name: "er-diagram.png", url: "https://x/er" },
      { name: "img/cpu.png|200", url: "https://x/cpu" },
    ]);
  });

  it("skips embeds with no resolved URL, and leaves assets unset when none resolve", () => {
    const notes = [
      note("S/A.md", ["present.png", "missing.png"]),
      note("S/B.md", ["nope.png"]),
    ];
    const concepts = [concept("S/A.md"), concept("S/B.md")];
    const urls = new Map([["present.png", "https://x/p"]]);

    attachAssetsToConcepts(concepts, notes, urls);

    expect(concepts[0]!.assets).toEqual([{ name: "present.png", url: "https://x/p" }]);
    // No embed resolved for B → assets stays undefined (no empty array written).
    expect(concepts[1]!.assets).toBeUndefined();
  });

  it("matches concepts to notes by sourcePath, not array position", () => {
    const notes = [note("S/A.md", []), note("S/B.md", ["b.png"])];
    // Concepts in a different order than notes.
    const concepts = [concept("S/B.md"), concept("S/A.md")];
    const urls = new Map([["b.png", "https://x/b"]]);

    attachAssetsToConcepts(concepts, notes, urls);

    const b = concepts.find((c) => c.sourcePath === "S/B.md")!;
    const a = concepts.find((c) => c.sourcePath === "S/A.md")!;
    expect(b.assets).toEqual([{ name: "b.png", url: "https://x/b" }]);
    expect(a.assets).toBeUndefined();
  });
});
