/**
 * Reverse-link computation for the "Linked from" panel — the Obsidian motif of
 * surfacing which other notes point *at* the one you're reading.
 *
 * Pure and dependency-free: both functions take the already-loaded concept list
 * and walk the *outgoing* edges of every other concept to find the ones whose
 * edge lands on `conceptId`. Nothing here fetches or mutates; the component
 * feeds them `useConcepts()` data and renders the result.
 *
 * Two edge kinds, two directions of meaning:
 *  - `links` is undirected relatedness ("see also"). Reversing it answers
 *    "who links here?" → {@link findBacklinks}.
 *  - `prerequisites` is directed ("learn X first"). Reversing it answers
 *    "what does mastering this unlock?" → {@link findDependents}.
 */
import type { Concept } from "@tutor/shared";

/** De-dupe by id and sort by title (case-insensitive), then id as a stable tie-break. */
function dedupeSortByTitle(concepts: Concept[]): Concept[] {
  const byId = new Map<string, Concept>();
  for (const c of concepts) {
    if (c && typeof c.id === "string" && !byId.has(c.id)) byId.set(c.id, c);
  }
  return [...byId.values()].sort(
    (a, b) =>
      (a.title ?? "").localeCompare(b.title ?? "", undefined, {
        sensitivity: "base",
      }) || a.id.localeCompare(b.id),
  );
}

/**
 * Every concept that wikilinks *to* `conceptId` — i.e. whose `links` array
 * contains it. The inverse of a concept's own `links`, giving the "Linked from"
 * set. Self-references are excluded; the result is de-duped and ordered by title
 * for a stable render. Tolerant of concepts with a missing/empty/non-array
 * `links` field (treated as no outgoing links).
 */
export function findBacklinks(
  conceptId: string,
  concepts: Concept[],
): Concept[] {
  if (!conceptId || !Array.isArray(concepts)) return [];
  const hits = concepts.filter(
    (c) =>
      c &&
      c.id !== conceptId &&
      Array.isArray(c.links) &&
      c.links.includes(conceptId),
  );
  return dedupeSortByTitle(hits);
}

/**
 * Every concept that lists `conceptId` among its `prerequisites` — the notes
 * this one *unlocks*. The directed counterpart to {@link findBacklinks}. Same
 * de-dupe / self-exclude / title-order guarantees, and the same tolerance for a
 * missing or non-array `prerequisites` field.
 */
export function findDependents(
  conceptId: string,
  concepts: Concept[],
): Concept[] {
  if (!conceptId || !Array.isArray(concepts)) return [];
  const hits = concepts.filter(
    (c) =>
      c &&
      c.id !== conceptId &&
      Array.isArray(c.prerequisites) &&
      c.prerequisites.includes(conceptId),
  );
  return dedupeSortByTitle(hits);
}
