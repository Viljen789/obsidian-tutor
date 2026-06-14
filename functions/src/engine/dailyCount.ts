/**
 * Daily-new-cap support — PURE.
 *
 * The sequencer limits how many brand-new concepts a learner may START per day
 * (settings.dailyNewLimit), but it needs to be TOLD how many have already been
 * introduced today. A concept is "introduced" the moment it first gets a graded
 * answer — i.e. its first mastery `history` entry. We bucket by the UTC calendar
 * day of `nowMs` (the server clock), the same frame the SM-2 scheduling uses, so
 * the boundary is consistent end to end.
 */
import type { Mastery } from "@tutor/shared";

/** UTC calendar-day key (YYYY-MM-DD) for an epoch-ms instant. */
function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * How many concepts were first interacted with on the current day. Feeds
 * `selectNextItem({ newlyIntroducedToday })` so the daily-new cap actually bites.
 */
export function countNewlyIntroducedToday(
  masteries: Record<string, Mastery>,
  nowMs: number,
): number {
  const today = utcDayKey(nowMs);
  let n = 0;
  for (const m of Object.values(masteries)) {
    const first = m.history[0];
    if (!first) continue; // never answered → not yet introduced
    const firstMs = Date.parse(first.date);
    if (!Number.isNaN(firstMs) && utcDayKey(firstMs) === today) n++;
  }
  return n;
}
