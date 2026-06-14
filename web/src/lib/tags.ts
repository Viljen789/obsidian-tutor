/**
 * Pure, dependency-free helpers for working with Obsidian `#tags` on the
 * Progress page. The ingest pipeline already extracts tags into
 * `Concept.tags: string[]`; these helpers let the UI surface and filter by them.
 *
 * Case handling mirrors the parser (`functions/src/ingest/parse.ts` →
 * `mergeTags`): tags are de-duped case-insensitively using a lowercased key,
 * while the *first* spelling encountered is preserved. So a vault with both
 * `#Exam` and `#exam` collapses to a single `Exam` entry. Everything here is
 * tolerant of missing/empty `tags` arrays so a partly-imported vault never
 * throws.
 */
import type { Concept } from "@tutor/shared";

export interface TagCount {
  /** The tag, in its first-seen spelling (e.g. "Exam"). */
  tag: string;
  /** How many concepts carry this tag (case-insensitive match). */
  count: number;
}

/**
 * Collect every distinct tag across `concepts`, with a per-tag concept count.
 *
 * De-duping is case-insensitive (keyed on the lowercased tag) and the first
 * spelling wins, matching the parser. Within a single concept a tag is counted
 * at most once even if it appears twice under different casings. The result is
 * sorted by count (descending) then by tag name (case-insensitive, ascending)
 * so the busiest, then alphabetical, tags lead.
 */
export function collectTags(concepts: Concept[]): TagCount[] {
  // key = lowercased tag → { tag: first spelling, count }
  const byKey = new Map<string, TagCount>();

  for (const concept of concepts ?? []) {
    const tags = concept?.tags;
    if (!tags || tags.length === 0) continue;

    // De-dupe within this concept first so one note never double-counts a tag.
    const seenInConcept = new Set<string>();
    for (const raw of tags) {
      if (typeof raw !== "string") continue;
      const tag = raw.trim();
      if (tag.length === 0) continue;

      const key = tag.toLowerCase();
      if (seenInConcept.has(key)) continue;
      seenInConcept.add(key);

      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        // First spelling encountered wins, like the parser's mergeTags.
        byKey.set(key, { tag, count: 1 });
      }
    }
  }

  return [...byKey.values()].sort(
    (a, b) =>
      b.count - a.count || a.tag.toLowerCase().localeCompare(b.tag.toLowerCase()),
  );
}

/**
 * Filter `concepts` to those matching the `selected` tag set using OR / ANY
 * semantics: a concept is kept if it carries *any* one of the selected tags.
 * An empty selection is treated as "no filter" and returns every concept.
 *
 * Matching is case-insensitive so a selection built from `collectTags` output
 * (first-spelling) still matches concepts that spelled the tag differently. The
 * `selected` set may contain tags in any casing; they are lowercased here.
 */
export function filterByTags(concepts: Concept[], selected: Set<string>): Concept[] {
  const list = concepts ?? [];
  if (!selected || selected.size === 0) return list;

  // Normalize the selection once to a lowercased lookup set.
  const wanted = new Set<string>();
  for (const tag of selected) {
    if (typeof tag === "string" && tag.trim().length > 0) {
      wanted.add(tag.trim().toLowerCase());
    }
  }
  if (wanted.size === 0) return list;

  return list.filter((concept) => {
    const tags = concept?.tags;
    if (!tags || tags.length === 0) return false;
    for (const raw of tags) {
      if (typeof raw === "string" && wanted.has(raw.trim().toLowerCase())) {
        return true;
      }
    }
    return false;
  });
}
