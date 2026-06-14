/**
 * StreakBadge — a small flame + current-streak count for the app header.
 *
 * Quiet by design: it only appears once the learner has a live streak (>= 1
 * day). At zero it renders nothing, so a fresh or lapsed account sees an
 * uncluttered header rather than a "0" that reads as failure.
 */
import { Flame } from "lucide-react";
import { useStats } from "../lib/stats";

export function StreakBadge() {
  const { stats } = useStats();
  const streak = stats.currentStreak;

  // Nothing to celebrate yet — stay out of the way.
  if (streak < 1) return null;

  const label = `${streak}-day streak`;

  return (
    <span
      title={label}
      aria-label={label}
      className="inline-flex items-center gap-1 rounded-full bg-review/10 px-2 py-0.5 text-xs font-semibold text-muted"
    >
      <Flame size={13} className="text-review" aria-hidden />
      <span className="tabular-nums">{streak}</span>
    </span>
  );
}
