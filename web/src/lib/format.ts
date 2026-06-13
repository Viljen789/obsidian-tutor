/**
 * Small, dependency-free formatting helpers shared across views. Everything
 * here is pure and defensive — domain timestamps are ISO-8601 strings that may
 * be null, so parsing always tolerates bad/missing input.
 */
import type { MasteryStatus } from "@tutor/shared";

/** Parse an ISO timestamp to epoch ms, or null if absent/invalid. */
export function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** True when a due date is at or before `now` (defaults to current time). */
export function isDue(dueDate: string | null | undefined, now = Date.now()): boolean {
  const ms = toMs(dueDate);
  return ms !== null && ms <= now;
}

/** Human, relative phrasing for a due date: "Due now", "in 3 days", "yesterday". */
export function dueLabel(dueDate: string | null | undefined, now = Date.now()): string {
  const ms = toMs(dueDate);
  if (ms === null) return "Not scheduled";
  const diff = ms - now;
  const day = 86_400_000;
  if (diff <= 0) {
    const overdue = Math.round(-diff / day);
    if (overdue <= 0) return "Due now";
    if (overdue === 1) return "Due yesterday";
    return `Overdue ${overdue} days`;
  }
  const days = Math.round(diff / day);
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days < 7) return `Due in ${days} days`;
  if (days < 30) return `Due in ${Math.round(days / 7)} wk`;
  return `Due in ${Math.round(days / 30)} mo`;
}

/** Absolute, readable date — "Jun 13, 2026". Empty string when missing. */
export function shortDate(iso: string | null | undefined): string {
  const ms = toMs(iso);
  if (ms === null) return "";
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Mastery score (0..1) → integer percent. */
export function pct(score: number): number {
  return Math.round(Math.max(0, Math.min(1, score)) * 100);
}

export const STATUS_LABEL: Record<MasteryStatus, string> = {
  new: "New",
  learning: "Learning",
  review: "In review",
  mastered: "Mastered",
};

/** Format bytes for the upload screen. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
