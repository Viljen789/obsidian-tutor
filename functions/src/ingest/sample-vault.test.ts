/**
 * End-to-end test of the PURE ingestion pipeline against the real sample vault
 * checked into `sample-vault/`. Reads the actual `.md` files off disk, parses
 * and assembles the graph, then asserts the contract: correct titles/subjects/
 * tags, wikilinks resolved to concept ids, both subjects present, sensible
 * undirected links, and a directed prerequisite graph from the heuristic.
 *
 * (Storage download + LLM + Firestore are integration-tested by the orchestrator
 * in Phase 5; here we verify the deterministic core.)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import type { Concept } from "@tutor/shared";
import { parseNote } from "./parse";
import { assembleGraphWithWarnings, slugifyPath } from "./graph";
import { inferPrerequisites } from "./prereq";
import type { ParsedNote } from "./index";

// functions/src/ingest -> repo root -> sample-vault
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = path.resolve(HERE, "../../../sample-vault");

/** Recursively collect vault-relative paths of `.md` files, skipping dotfiles. */
function collectMarkdown(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue; // skip .obsidian etc.
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectMarkdown(full, root));
    } else if (entry.toLowerCase().endsWith(".md")) {
      out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  return out;
}

const IMPORT_ID = "test-import";
const ISO_NOW = "2026-06-13T00:00:00.000Z";

let notes: ParsedNote[];
let concepts: Concept[];
let warnings: string[];
let withPrereqs: Concept[];
let byId: Map<string, Concept>;
let idByTitle: Map<string, string>;

beforeAll(() => {
  const relPaths = collectMarkdown(VAULT_DIR);
  notes = relPaths.map((rel) =>
    parseNote(rel, readFileSync(path.join(VAULT_DIR, rel), "utf8")),
  );
  const assembled = assembleGraphWithWarnings(notes, IMPORT_ID, ISO_NOW);
  concepts = assembled.concepts;
  warnings = assembled.warnings;
  withPrereqs = inferPrerequisites(concepts);
  byId = new Map(withPrereqs.map((c) => [c.id, c]));
  idByTitle = new Map(concepts.map((c) => [c.title.toLowerCase(), c.id]));
});

describe("sample vault ingestion", () => {
  it("finds a realistic number of notes across the vault", () => {
    expect(notes.length).toBeGreaterThanOrEqual(12);
  });

  it("covers BOTH subjects", () => {
    const subjects = new Set(concepts.map((c) => c.subject));
    expect(subjects).toContain("Low-Level Programming");
    expect(subjects).toContain("Databases");
  });

  it("assigns stable, unique, slugified concept ids tied to the source path", () => {
    const ids = concepts.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
    for (const c of concepts) {
      expect(c.id).toBe(slugifyPath(c.sourcePath));
      expect(c.id).toMatch(/^[a-z0-9-]+$/); // safe slug
      expect(c.importId).toBe(IMPORT_ID);
      expect(c.createdAt).toBe(ISO_NOW);
      expect(c.updatedAt).toBe(ISO_NOW);
    }
  });

  it("reads titles/subjects/tags correctly (frontmatter wins, fallbacks work)", () => {
    // Frontmatter title differs from filename ("Registers.md" -> "CPU Registers").
    const registers = concepts.find((c) => c.sourcePath.endsWith("Registers.md"));
    expect(registers?.title).toBe("CPU Registers");
    expect(registers?.subject).toBe("Low-Level Programming");
    expect(registers?.tags).toEqual(
      expect.arrayContaining(["cpu", "hardware", "fundamentals"]),
    );

    // Note with no frontmatter falls back to filename + top-level folder.
    const planner = concepts.find((c) => c.sourcePath.endsWith("Query Planner.md"));
    expect(planner?.title).toBe("Query Planner");
    expect(planner?.subject).toBe("Databases");
    expect(planner?.tags).toEqual([]);
  });

  it("resolves wikilinks to concept ids (including alias / heading / filename-vs-title)", () => {
    const pointers = byId.get(idByTitle.get("pointers")!)!;
    const memoryLayoutId = idByTitle.get("memory layout")!;
    // [[Memory Layout]] resolves to the Memory Layout concept id.
    expect(pointers.links).toContain(memoryLayoutId);
    // Every link is a real concept id, never a raw title string.
    for (const c of withPrereqs) {
      for (const target of c.links) {
        expect(byId.has(target)).toBe(true);
        expect(target).not.toBe(c.id); // no self-links
      }
    }

    // Aliased link [[Indexing|good indexes]] in "SQL Joins" resolves to Indexing.
    const sqlJoins = byId.get(idByTitle.get("sql joins")!)!;
    expect(sqlJoins.links).toContain(idByTitle.get("indexing")!);

    // Filename-vs-title: Assembly Basics links [[Registers]] (filename) which
    // resolves to the "CPU Registers" concept.
    const assembly = byId.get(idByTitle.get("assembly basics")!)!;
    expect(assembly.links).toContain(idByTitle.get("cpu registers")!);
  });

  it("produces sensible UNDIRECTED links (mostly reciprocal references)", () => {
    // The vault is authored so linked notes reference each other; spot-check a few.
    const memId = idByTitle.get("memory layout")!;
    const ptrId = idByTitle.get("pointers")!;
    const mem = byId.get(memId)!;
    const ptr = byId.get(ptrId)!;
    expect(mem.links).toContain(ptrId);
    expect(ptr.links).toContain(memId);
    // Every concept participates in the graph (no orphans in this curated vault).
    for (const c of withPrereqs) expect(c.links.length).toBeGreaterThan(0);
  });

  it("does not leave wikilinks unresolved in this curated vault", () => {
    const unresolved = warnings.filter((w) => w.includes("Unresolved wikilink"));
    expect(unresolved).toEqual([]);
  });

  it("surfaces a no-frontmatter warning for the bare note", () => {
    expect(warnings.some((w) => w.includes("Query Planner.md") && w.includes("no frontmatter"))).toBe(true);
  });

  it("infers a DIRECTED prerequisite graph (low out-degree leaves come first)", () => {
    // The pure heuristic orients edges by structural foundational-ness (fewer
    // outgoing links => more foundational => prerequisite). Pick pairs where the
    // out-degree gap is unambiguous so direction is deterministic.

    // ACID (1 outgoing link) is the leaf that Transactions (3) builds on, so
    // ACID is a prerequisite of Transactions, not vice-versa.
    const acidId = idByTitle.get("acid")!;
    const txId = idByTitle.get("transactions")!;
    expect(byId.get(txId)!.prerequisites).toContain(acidId);
    expect(byId.get(acidId)!.prerequisites).not.toContain(txId);

    // B-Trees (2 outgoing) is more foundational than Indexing (3) → prereq of it.
    const btreeId = idByTitle.get("b-trees")!;
    const indexId = idByTitle.get("indexing")!;
    expect(byId.get(indexId)!.prerequisites).toContain(btreeId);

    // CPU Registers (2 outgoing) is a prerequisite of Assembly Basics (3).
    const regId = idByTitle.get("cpu registers")!;
    const asmId = idByTitle.get("assembly basics")!;
    expect(byId.get(asmId)!.prerequisites).toContain(regId);

    // Directedness: real directed edges exist, and no self-prerequisites.
    const totalEdges = withPrereqs.reduce((n, c) => n + c.prerequisites.length, 0);
    expect(totalEdges).toBeGreaterThan(0);
    for (const c of withPrereqs) expect(c.prerequisites).not.toContain(c.id);
  });

  it("does not create a directed cycle between any reciprocal pair", () => {
    // For every directed prereq edge from->to, the reverse edge must NOT exist
    // (the heuristic orients each undirected pair exactly one way).
    for (const c of withPrereqs) {
      for (const prereqId of c.prerequisites) {
        const prereq = byId.get(prereqId)!;
        expect(prereq.prerequisites).not.toContain(c.id);
      }
    }
  });
});
