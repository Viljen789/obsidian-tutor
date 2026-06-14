/**
 * Pure exam-readiness computation. No React, no Firestore — just a fold over a
 * subject's concepts + mastery into a single 0..100 "ready" score plus the
 * sub-signals that feed it, so the panel can explain *why* a number is what it
 * is. Everything here tolerates missing/empty input and never throws.
 */
import type { Concept, Mastery } from "@tutor/shared";
import { isDue } from "./format";

export interface SubjectReadiness {
  /** Headline 0..100, rounded and clamped. */
  score: number;
  /** Fraction of the subject's concepts actually started (status !== "new"). */
  coverage: number;
  /** Mean masteryScore (0..1) over the subject's concepts; missing → 0. */
  avgMastery: number;
  /** How many of the subject's concepts are overdue for review right now. */
  overdueCount: number;
  /** Total concepts in the subject. */
  conceptCount: number;
}

/**
 * Blend three learner signals into a readiness score for one subject:
 *   - avgMastery  (50%) — how well the material is known on average.
 *   - coverage    (30%) — how much of it has even been started.
 *   - 1-overdue   (20%) — freshness; overdue reviews drag readiness down.
 *
 * A subject with no concepts (or no matches) scores 0 — there's nothing to be
 * ready for yet.
 */
export function subjectReadiness(
  concepts: Concept[],
  mastery: Record<string, Mastery>,
  subject: string,
): SubjectReadiness {
  // Narrow to just this subject's concepts.
  const mine = concepts.filter((c) => c.subject === subject);
  const conceptCount = mine.length;

  // Empty subject → a well-defined zero rather than NaN from a 0-length mean.
  if (conceptCount === 0) {
    return { score: 0, coverage: 0, avgMastery: 0, overdueCount: 0, conceptCount: 0 };
  }

  let masterySum = 0; // Σ masteryScore (missing mastery contributes 0)
  let startedCount = 0; // concepts with status !== "new"
  let overdueCount = 0; // concepts whose review is due/overdue

  for (const c of mine) {
    const m = mastery[c.id];
    masterySum += m?.masteryScore ?? 0;
    if (m && m.status !== "new") startedCount += 1;
    // Only a started concept can meaningfully be "overdue"; an un-started
    // concept has no schedule. isDue is null/undefined-tolerant either way.
    if (m && isDue(m.dueDate)) overdueCount += 1;
  }

  const avgMastery = masterySum / conceptCount; // 0..1
  const coverage = startedCount / conceptCount; // 0..1
  const overdueFraction = overdueCount / conceptCount; // 0..1

  // Weighted blend, then to a clamped integer percent.
  const raw = 0.5 * avgMastery + 0.3 * coverage + 0.2 * (1 - overdueFraction);
  const score = Math.max(0, Math.min(100, Math.round(100 * raw)));

  return { score, coverage, avgMastery, overdueCount, conceptCount };
}

/**
 * Whole days from *today* (local midnight) until an ISO `yyyy-mm-dd` date.
 * Negative when the date is in the past, 0 for today, null if unparseable.
 *
 * We compare calendar days (both ends snapped to local midnight) so "days left"
 * doesn't flicker with the time of day — 1 means "tomorrow" all day today.
 */
export function daysUntil(isoDate: string): number | null {
  const target = Date.parse(isoDate);
  if (Number.isNaN(target)) return null;

  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  const MS_PER_DAY = 86_400_000;
  const diff = startOfDay(target) - startOfDay(Date.now());
  return Math.round(diff / MS_PER_DAY);
}
