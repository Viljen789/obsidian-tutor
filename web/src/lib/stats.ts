/**
 * Daily-streak state: the "habit loop" that rewards consecutive study days.
 *
 * The model is a single Firestore summary doc per user (`paths.statsDoc(uid)` =
 * `users/{uid}/stats/summary`), low-stakes and client-written (the rules allow
 * the owner to read/write their own stats, like sessions). The backend is NOT
 * the source of truth here — we read-modify-write from the client after each
 * graded answer / card review.
 *
 * Two pieces live here:
 *   - `advanceStreak`, a PURE reducer over `UserStats` keyed by "today" — easy to
 *     reason about and unit-test (no Date, no Firestore, no React).
 *   - `useStats`, a react-query wrapper that reads the doc, exposes the current
 *     stats (falling back to EMPTY_USER_STATS), and a `recordActivity()` action
 *     the orchestrator calls from the grading success paths.
 *
 * Day math is deliberately LOCAL-calendar (a "study day" is the learner's
 * midnight-to-midnight, not UTC's), so we build keys from `Date` parts rather
 * than slicing `toISOString()`.
 */
import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { EMPTY_USER_STATS, paths, type UserStats } from "@tutor/shared";
import { db } from "./firebase";
import { useAuth } from "./auth";

// ---------------------------------------------------------------------------
// Local-calendar day helpers (format: YYYY-MM-DD).
// ---------------------------------------------------------------------------

/** Zero-pad a 1- or 2-digit number to 2 chars ("3" -> "03"). */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The local-calendar key for a Date, e.g. "2026-06-13". Uses the runtime's
 * local timezone (getFullYear/getMonth/getDate), NOT UTC — so a study session
 * at 11pm and one at 1am the next morning land on different days for the user,
 * regardless of where UTC's date boundary falls.
 */
export function dayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Today's local-calendar key. Thin wrapper so callers read cleanly. */
export function todayKey(now: Date = new Date()): string {
  return dayKey(now);
}

/**
 * The day key `n` days offset from `d` (negative = earlier). Constructs a new
 * local Date and lets the Date constructor normalise month/year rollovers, so
 * `addDays(Jun 1, -1)` correctly yields "May 31". Time-of-day is irrelevant —
 * we only read the calendar parts back out.
 */
export function addDays(d: Date, n: number): string {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  return dayKey(copy);
}

/**
 * Parse a "YYYY-MM-DD" day key into a local Date at noon. Noon (not midnight)
 * keeps the calendar day stable across DST transitions, and lets `addDays` roll
 * months/years correctly. Tolerates a malformed key by falling back to today.
 */
function parseDayKey(key: string): Date {
  const parts = key.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return new Date();
  }
  return new Date(y, m - 1, d, 12, 0, 0);
}

// ---------------------------------------------------------------------------
// Pure streak reducer.
// ---------------------------------------------------------------------------

/**
 * Fold one study activity into the running stats, given the local-calendar key
 * for "today". PURE: no clock, no I/O — the caller supplies `todayKey` so this
 * is fully deterministic and unit-testable.
 *
 * Streak rules:
 *   - Already active today (`lastActiveDay === todayKey`): the streak is already
 *     counted — leave currentStreak untouched, just tally another review.
 *   - Active exactly yesterday: a continued streak — `currentStreak + 1`.
 *   - Any other case (a gap of 2+ days, or the very first activity ever):
 *     the streak resets/starts at 1.
 *
 * Always: `totalReviews + 1`, `longestStreak = max(longestStreak, currentStreak)`,
 * `lastActiveDay = todayKey`, and `updatedAt` stamped now (ISO).
 */
export function advanceStreak(prev: UserStats, todayKey: string): UserStats {
  // "Yesterday" relative to the supplied today key. We parse the key back into a
  // local Date (noon avoids any DST edge near midnight) so addDays can roll the
  // calendar correctly across month/year boundaries.
  const yesterdayKey = addDays(parseDayKey(todayKey), -1);

  let currentStreak: number;
  if (prev.lastActiveDay === todayKey) {
    // Same day — streak unchanged, this is just another review today.
    currentStreak = prev.currentStreak;
  } else if (prev.lastActiveDay === yesterdayKey) {
    // Consecutive day — extend the streak.
    currentStreak = prev.currentStreak + 1;
  } else {
    // First activity ever, or a broken chain — (re)start at 1.
    currentStreak = 1;
  }

  return {
    currentStreak,
    longestStreak: Math.max(prev.longestStreak, currentStreak),
    lastActiveDay: todayKey,
    totalReviews: prev.totalReviews + 1,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Firestore I/O + react-query hook.
// ---------------------------------------------------------------------------

/** Centralised query key so callers/invalidators agree. */
export const statsKey = (uid: string) => ["stats", uid] as const;

/** Read the summary doc (or null if the learner has no activity yet). */
async function fetchStats(uid: string): Promise<UserStats | null> {
  const snap = await getDoc(doc(db, paths.statsDoc(uid)));
  return snap.exists() ? (snap.data() as UserStats) : null;
}

export interface UseStats {
  /** Current stats — never null; falls back to EMPTY_USER_STATS while loading/absent. */
  stats: UserStats;
  isLoading: boolean;
  /**
   * Record one study activity (a graded answer or card review): read the latest
   * stats, advance the streak for today, persist, and refresh the cache so the
   * header badge updates live. Safe to call repeatedly in a session; the
   * same-day branch keeps the streak stable while still tallying reviews.
   */
  recordActivity: () => Promise<void>;
}

/**
 * Streak/stats hook. Reads `users/{uid}/stats/summary` via react-query and
 * exposes a `recordActivity` mutation-like action. Disabled (and a no-op) until
 * a user is signed in.
 */
export function useStats(): UseStats {
  const { user } = useAuth();
  const uid = user?.uid;
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: statsKey(uid ?? "anon"),
    enabled: !!uid,
    queryFn: () => fetchStats(uid!),
  });

  const recordActivity = useCallback(async () => {
    if (!uid) return; // not signed in — nothing to record.

    // Prefer the freshest server state so concurrent devices/tabs don't clobber
    // each other's count; fall back to cache, then to empty.
    const fromServer = await fetchStats(uid).catch(() => undefined);
    const prev =
      fromServer ??
      qc.getQueryData<UserStats | null>(statsKey(uid)) ??
      EMPTY_USER_STATS;

    const next = advanceStreak(prev, todayKey());
    await setDoc(doc(db, paths.statsDoc(uid)), next);

    // Seed the cache immediately (snappy badge), then invalidate to reconcile.
    qc.setQueryData(statsKey(uid), next);
    void qc.invalidateQueries({ queryKey: statsKey(uid) });
  }, [uid, qc]);

  return {
    stats: query.data ?? EMPTY_USER_STATS,
    isLoading: query.isPending && !!uid,
    recordActivity,
  };
}

/**
 * Imperative one-shot for non-hook call sites (e.g. a plain success callback
 * that already has the uid + a QueryClient). Mirrors `recordActivity` but takes
 * its dependencies as arguments. The orchestrator can prefer the hook; this is
 * here so the grading path has a no-React-context option if it needs one.
 */
export async function recordStudyActivity(
  uid: string,
  qc?: import("@tanstack/react-query").QueryClient,
): Promise<void> {
  if (!uid) return;
  const fromServer = await fetchStats(uid).catch(() => undefined);
  const prev =
    fromServer ??
    qc?.getQueryData<UserStats | null>(statsKey(uid)) ??
    EMPTY_USER_STATS;
  const next = advanceStreak(prev, todayKey());
  await setDoc(doc(db, paths.statsDoc(uid)), next);
  if (qc) {
    qc.setQueryData(statsKey(uid), next);
    void qc.invalidateQueries({ queryKey: statsKey(uid) });
  }
}
