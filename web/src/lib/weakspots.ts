/**
 * Pure ranking helper for the weak-spot pre-exam drill.
 *
 * A drill is *targeted cramming*: it reinforces the concepts the learner has
 * actually started but knows least well, so they can shore up their soft spots
 * right before an exam. This is deliberately distinct from scheduled Review
 * (which the spacing algorithm pages in by due date) — here we explicitly sort
 * by *weakness* first, with overdue-ness only as a tie-break.
 *
 * Everything here is pure and defensive: it never mutates its inputs, tolerates
 * missing/partial mastery, and returns `[]` rather than throwing on bad data.
 */
import type { Concept, Mastery } from "@tutor/shared";
import { toMs } from "./format";

/** How weak is "weak enough to drill" — see `selectWeakSpots`. */
export interface WeakSpotOptions {
  /** Restrict to a single subject (exact match). Omit / undefined = all subjects. */
  subject?: string;
  /** Maximum number of concepts to return. Defaults to 10. */
  limit?: number;
}

/**
 * Rank a learner's *started-but-weak* concepts, weakest first.
 *
 * Eligibility — a concept is a drill candidate only when:
 *   1. a mastery record exists for it, AND
 *   2. its `status` is not `"new"` (the learner has actually engaged with it).
 * Brand-new concepts belong in Learn, not a reinforcement drill, so they're
 * excluded even if a placeholder mastery row exists.
 *
 * Ordering (weakest first):
 *   • Primary:   ascending `masteryScore` — the least-mastered concept leads.
 *   • Tie-break: more-overdue first. We compare `dueDate` as epoch millis so an
 *                earlier (further-past) due date sorts ahead; concepts with no
 *                due date sort last within a tie (nothing overdue to cram).
 *
 * @param concepts  All of the learner's concepts (any order).
 * @param mastery   Mastery keyed by conceptId, as returned by `useMastery()`.
 * @param opts      Optional subject filter and result cap.
 * @returns A new array of the weakest concepts, at most `opts.limit` long.
 */
export function selectWeakSpots(
  concepts: Concept[],
  mastery: Record<string, Mastery>,
  opts: WeakSpotOptions = {},
): Concept[] {
  // Defensive: bail calmly on absent/garbage inputs rather than throwing.
  if (!Array.isArray(concepts) || concepts.length === 0) return [];
  const byId = mastery ?? {};
  const limit = opts.limit ?? 10;
  if (limit <= 0) return [];

  // Pair each concept with its mastery, keeping only started (non-"new") ones
  // within the requested subject scope. We carry the mastery alongside the
  // concept so the comparator doesn't have to re-look-it-up per comparison.
  const candidates: { concept: Concept; mastery: Mastery }[] = [];
  for (const concept of concepts) {
    if (opts.subject && concept.subject !== opts.subject) continue;
    const m = byId[concept.id];
    // Must be started: mastery exists and the learner has moved past "new".
    if (!m || m.status === "new") continue;
    candidates.push({ concept, mastery: m });
  }

  // Weakest first: lowest masteryScore leads; ties broken by who's more overdue.
  candidates.sort((a, b) => {
    // Treat a missing/NaN score as fully unknown (0) so it sorts to the front.
    const sa = Number.isFinite(a.mastery.masteryScore) ? a.mastery.masteryScore : 0;
    const sb = Number.isFinite(b.mastery.masteryScore) ? b.mastery.masteryScore : 0;
    if (sa !== sb) return sa - sb; // ascending mastery → weakest first

    // Tie-break: more-overdue first. Earlier due date (smaller ms) comes first;
    // no due date → +Infinity so un-scheduled concepts trail the overdue ones.
    const da = toMs(a.mastery.dueDate) ?? Number.POSITIVE_INFINITY;
    const db = toMs(b.mastery.dueDate) ?? Number.POSITIVE_INFINITY;
    return da - db;
  });

  return candidates.slice(0, limit).map((x) => x.concept);
}
