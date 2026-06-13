/**
 * Pure concept-graph assembly.
 *
 * Turns `ParsedNote`s into `Concept`s: assigns a stable conceptId (slug of the
 * source path), resolves each wikilink target to a conceptId by matching note
 * titles/filenames case-insensitively, and records the resolved targets as the
 * undirected `links`. Unresolved wikilinks are surfaced as warnings (not errors)
 * so ingestion is robust to typos and links to not-yet-written notes.
 *
 * No clock here: the caller passes an ISO timestamp so the function stays pure.
 */
import type { Concept } from "@tutor/shared";
import type { ParsedNote } from "./index";

/** A stable, URL/Firestore-safe slug derived from a vault-relative path. */
export function slugifyPath(sourcePath: string): string {
  return sourcePath
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "")
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, "-") // non-alnum -> dash
    .replace(/\//g, "--") // path separators -> double dash (kept reversible-ish)
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Filename without directories or the `.md` extension. */
function fileBaseName(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, "/");
  const last = normalized.split("/").pop() ?? normalized;
  return last.replace(/\.md$/i, "");
}

export interface AssembleResult {
  concepts: Concept[];
  /** Human-readable non-fatal issues (unresolved links, no-frontmatter notes). */
  warnings: string[];
}

/**
 * Build the concept graph plus warnings (the richer entry point used by the
 * callable). `assembleGraph` wraps this and returns only the concepts.
 *
 * @param notes     parsed notes
 * @param importId  groups this ingestion run
 * @param isoNow    ISO-8601 timestamp the caller supplies (no Date.now here)
 */
export function assembleGraphWithWarnings(
  notes: ParsedNote[],
  importId: string,
  isoNow: string,
): AssembleResult {
  // Build a case-insensitive lookup from both note title and filename to its
  // conceptId. Title and filename can differ (e.g. "CPU Registers" vs
  // "Registers.md"); a wikilink may reference either.
  const idByName = new Map<string, string>();
  for (const note of notes) {
    const id = slugifyPath(note.sourcePath);
    const titleKey = note.title.trim().toLowerCase();
    const fileKey = fileBaseName(note.sourcePath).trim().toLowerCase();
    // First write wins so duplicate names resolve deterministically by note order.
    if (!idByName.has(titleKey)) idByName.set(titleKey, id);
    if (!idByName.has(fileKey)) idByName.set(fileKey, id);
  }

  const warnings: string[] = [];
  const concepts: Concept[] = notes.map((note) => {
    const id = slugifyPath(note.sourcePath);
    const links: string[] = [];
    const seen = new Set<string>();

    for (const target of note.wikilinks) {
      const resolved = idByName.get(target.trim().toLowerCase());
      if (!resolved) {
        warnings.push(
          `Unresolved wikilink "[[${target}]]" in ${note.sourcePath}`,
        );
        continue;
      }
      if (resolved === id) continue; // ignore self-links
      if (!seen.has(resolved)) {
        seen.add(resolved);
        links.push(resolved);
      }
    }

    if (Object.keys(note.frontmatter).length === 0) {
      warnings.push(`Note ${note.sourcePath} has no frontmatter`);
    }

    return {
      id,
      title: note.title,
      subject: note.subject,
      bodyMarkdown: note.bodyMarkdown,
      tags: note.tags,
      links,
      prerequisites: [], // filled by the prereq pass
      sourcePath: note.sourcePath,
      importId,
      createdAt: isoNow,
      updatedAt: isoNow,
    };
  });

  return { concepts, warnings };
}

/**
 * Resolve wikilinks and build the undirected link graph (pure, contract shape).
 * Returns only the concepts; use `assembleGraphWithWarnings` to also get the
 * unresolved-link warnings the callable surfaces to the client.
 */
export function assembleGraph(notes: ParsedNote[], importId: string): Concept[] {
  // A fixed epoch keeps the pure function deterministic and testable; the
  // callable overrides timestamps via assembleGraphWithWarnings(isoNow).
  return assembleGraphWithWarnings(notes, importId, new Date(0).toISOString())
    .concepts;
}
