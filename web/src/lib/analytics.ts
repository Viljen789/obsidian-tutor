/**
 * Pure aggregation helpers for the Progress page's analytics section. Everything
 * here is derived from data the app already holds (concepts + the per-concept
 * mastery records), so there is no backend involvement.
 *
 * Two conventions worth calling out:
 *  - Days are *local* calendar days. A review at 23:00 and one at 01:00 the next
 *    morning land on different squares the way a learner experiences them, so we
 *    bucket by `YYYY-MM-DD` built from local Date parts — never `toISOString()`,
 *    which would silently shift everyone east/west into UTC days.
 *  - Every helper tolerates empty / missing input. A learner who has imported a
 *    vault but never practised should get sensible zero-filled output, not a
 *    crash, so the page can render its frame honestly.
 */
import type { Concept, Mastery, MasteryStatus } from "@tutor/shared";

/** A concept-id -> Mastery map, exactly as `useMastery()` returns it. */
export type MasteryMap = Record<string, Mastery>;

/** One day's review tally for the heatmap. `date` is a local `YYYY-MM-DD` key. */
export interface HeatmapCell {
  date: string;
  count: number;
}

/** The four mastery statuses, in the order we like to present them. */
export const STATUS_ORDER: MasteryStatus[] = ["new", "learning", "review", "mastered"];

/** Local `YYYY-MM-DD` for a Date — calendar-day key, never UTC-shifted. */
export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Midnight (local) at the start of `d`'s calendar day — a stable day anchor. */
function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Flatten every concept's review `history` into per-local-day counts for the
 * trailing `days` window (default ~119 ≈ 17 weeks, a tidy GitHub-style grid).
 *
 * Returns one cell *per day* in the window — including zero-review days — in
 * chronological order ending today, so the caller can lay them straight into a
 * calendar grid without backfilling gaps. Entries with unparseable or
 * out-of-window dates are ignored.
 */
export function reviewHeatmap(
  masteryMap: MasteryMap,
  { days = 119, now = new Date() }: { days?: number; now?: Date } = {},
): HeatmapCell[] {
  const span = Math.max(1, Math.floor(days));
  const today = startOfLocalDay(now);

  // Pre-seed an ordered map of every day in the window at zero. The window is
  // [today - (span - 1), today] inclusive, so it contains exactly `span` days.
  const counts = new Map<string, number>();
  const start = new Date(today);
  start.setDate(start.getDate() - (span - 1));
  for (let i = 0; i < span; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    counts.set(localDayKey(d), 0);
  }

  // Tally reviews. We only bump days that exist in the pre-seeded window, which
  // both bounds the result and discards anything older than the window or in the
  // future (clock skew, imported data) without extra range math.
  for (const mastery of Object.values(masteryMap)) {
    const history = mastery?.history;
    if (!history) continue;
    for (const entry of history) {
      const ms = Date.parse(entry?.date ?? "");
      if (Number.isNaN(ms)) continue;
      const key = localDayKey(new Date(ms));
      const current = counts.get(key);
      if (current !== undefined) counts.set(key, current + 1);
    }
  }

  // Map preserves insertion order, which is already chronological.
  return [...counts.entries()].map(([date, count]) => ({ date, count }));
}

/** One status bucket: how many concepts currently sit at this mastery status. */
export interface StatusCount {
  status: MasteryStatus;
  count: number;
}

/**
 * Count concepts per mastery status. A concept with no mastery record yet (never
 * practised, freshly imported) counts as "new", mirroring how the rest of the
 * Progress page treats absent mastery. Always returns all four statuses in
 * `STATUS_ORDER`, so the breakdown row is stable even at zero.
 */
export function statusBreakdown(concepts: Concept[], masteryMap: MasteryMap): StatusCount[] {
  const tally: Record<MasteryStatus, number> = {
    new: 0,
    learning: 0,
    review: 0,
    mastered: 0,
  };
  for (const concept of concepts ?? []) {
    const status = masteryMap[concept.id]?.status ?? "new";
    tally[status]++;
  }
  return STATUS_ORDER.map((status) => ({ status, count: tally[status] }));
}

/** Per-subject mastery rollup: mean score, mastered count, and total concepts. */
export interface SubjectMastery {
  subject: string;
  /** Mean masteryScore across the subject's concepts, 0..1 (0 when empty). */
  avg: number;
  /** Concepts in this subject whose status is "mastered". */
  mastered: number;
  /** Total concepts in this subject. */
  total: number;
}

/**
 * Average mastery + mastered count per subject, sorted by average descending
 * (ties broken alphabetically) so the strongest subjects lead. Concepts without
 * a mastery record contribute a score of 0 and never count as mastered.
 */
export function subjectMastery(concepts: Concept[], masteryMap: MasteryMap): SubjectMastery[] {
  const acc = new Map<string, { sum: number; mastered: number; total: number }>();
  for (const concept of concepts ?? []) {
    const m = masteryMap[concept.id];
    const bucket = acc.get(concept.subject) ?? { sum: 0, mastered: 0, total: 0 };
    bucket.sum += m?.masteryScore ?? 0;
    if (m?.status === "mastered") bucket.mastered++;
    bucket.total++;
    acc.set(concept.subject, bucket);
  }
  return [...acc.entries()]
    .map(([subject, { sum, mastered, total }]) => ({
      subject,
      avg: total > 0 ? sum / total : 0,
      mastered,
      total,
    }))
    .sort((a, b) => b.avg - a.avg || a.subject.localeCompare(b.subject));
}

/** Headline review activity, derived from the same daily buckets as the heatmap. */
export interface ReviewStreakStats {
  /** Total reviews across the heatmap window. */
  totalReviews: number;
  /** Days in the window with at least one review. */
  activeDays: number;
  /** Highest single-day review count in the window. */
  bestDay: number;
  /** Length of the current run of consecutive active days ending today. */
  currentStreak: number;
}

/**
 * Roll a heatmap (the chronological cells from `reviewHeatmap`) up into headline
 * totals. Kept separate from `reviewHeatmap` so a caller can render the grid and
 * the numbers from a single pass of source data. Empty input yields all zeros.
 */
export function reviewStreakStats(cells: HeatmapCell[]): ReviewStreakStats {
  let totalReviews = 0;
  let activeDays = 0;
  let bestDay = 0;
  for (const { count } of cells ?? []) {
    totalReviews += count;
    if (count > 0) activeDays++;
    if (count > bestDay) bestDay = count;
  }

  // Current streak: walk backwards from the most recent day (the window ends
  // today) until we hit a day with no reviews.
  let currentStreak = 0;
  for (let i = (cells?.length ?? 0) - 1; i >= 0; i--) {
    if ((cells[i]?.count ?? 0) > 0) currentStreak++;
    else break;
  }

  return { totalReviews, activeDays, bestDay, currentStreak };
}
