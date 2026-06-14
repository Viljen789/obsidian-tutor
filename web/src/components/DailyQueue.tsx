/**
 * DailyQueue — the dashboard's "today's session" card: a calm summary of what's
 * waiting (reviews due + new concepts unlocked), a glance at the learner's
 * momentum (streak + reviews done today), and a single primary action that
 * hands off to the adaptive sequencer.
 *
 * It reuses the routing pattern from Dashboard's NextUpCard: ask `api.nextItem`
 * what to do, then route to /review/:id or /learn/:id based on the action. The
 * counts are computed client-side from concepts + mastery so the card is
 * meaningful even before the sequencer responds.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { CalendarCheck, Flame, GraduationCap, RotateCcw, Sparkles } from "lucide-react";
import { DEFAULT_USER_SETTINGS, type NextItem } from "@tutor/shared";
import { api } from "../lib/api";
import { useConcepts, useMastery } from "../lib/firestore-hooks";
import { isDue } from "../lib/format";
import { useStats, todayKey } from "../lib/stats";
import { Button, Card, Eyebrow, Pill, Skeleton } from "./ui";

export function DailyQueue() {
  const navigate = useNavigate();
  const concepts = useConcepts();
  const mastery = useMastery();
  const { stats } = useStats();

  const loading = concepts.isPending || mastery.isPending;

  const { dueCount, newCount } = useMemo(() => {
    const masteryMap = mastery.data ?? {};
    const list = concepts.data ?? [];

    // Reviews due today: any mastery record whose dueDate has passed.
    const dueCount = Object.values(masteryMap).filter((m) => isDue(m.dueDate)).length;

    // New / unlocked concepts: those with no mastery yet, or still in "new"
    // status. We cap the *displayed* figure at the daily new-concept limit so
    // the card promises a realistic session, not the whole backlog.
    const rawNew = list.filter((c) => {
      const m = masteryMap[c.id];
      return !m || m.status === "new";
    }).length;
    const newCount = Math.min(rawNew, DEFAULT_USER_SETTINGS.dailyNewLimit);

    return { dueCount, newCount };
  }, [concepts.data, mastery.data]);

  // Reviews already done today — surfaced as gentle positive feedback.
  const reviewsToday = stats.lastActiveDay === todayKey() ? stats.totalReviews : 0;

  const next = useMutation({
    mutationFn: (): Promise<NextItem> => api.nextItem({}),
    onSuccess: (item) => {
      if (item.action === "review" && item.conceptId) navigate(`/review/${item.conceptId}`);
      else if (item.action === "learn" && item.conceptId) navigate(`/learn/${item.conceptId}`);
      // action "none" leaves the learner here; the empty copy below already
      // explains there's nothing queued.
    },
  });

  if (loading) {
    return (
      <Card className="p-6">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="mt-3 h-6 w-56" />
        <Skeleton className="mt-4 h-9 w-44 rounded-xl" />
      </Card>
    );
  }

  const total = dueCount + newCount;
  const allCaught = total === 0;
  // Reviews lean "review" tone (warm), pure-new sessions lean "accent".
  const tone = dueCount > 0 ? "review" : "accent";

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <Eyebrow tone={allCaught ? "neutral" : tone}>Today's session</Eyebrow>
          <h2 className="mt-1.5 font-serif text-xl text-ink">
            {allCaught
              ? reviewsToday > 0
                ? "You're done for today"
                : "Nothing queued"
              : "Your plan is ready"}
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            {allCaught
              ? reviewsToday > 0
                ? "Everything's reviewed and nothing new is due. Rest the recall in — it'll be here tomorrow."
                : "No reviews are due and no new concepts are unlocked yet. Learn freely, or import more material."
              : "A focused set, chosen to move the needle. The tutor will pick the best place to start."}
          </p>

          {/* What's in the queue — quiet counts, only shown when present. */}
          {!allCaught && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {dueCount > 0 && (
                <Pill tone="review">
                  <RotateCcw size={12} /> {dueCount} to review
                </Pill>
              )}
              {newCount > 0 && (
                <Pill tone="accent">
                  <GraduationCap size={12} /> {newCount} new
                </Pill>
              )}
            </div>
          )}
        </div>

        {!allCaught && (
          <Button
            tone={tone}
            icon={Sparkles}
            loading={next.isPending}
            onClick={() => next.mutate()}
            className="shrink-0"
          >
            Start today's session
          </Button>
        )}
      </div>

      {/* Momentum footer: today's streak + reviews logged today. */}
      <div className="flex items-center gap-5 border-t border-border px-6 py-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Flame
            size={14}
            className={stats.currentStreak > 0 ? "text-review" : "text-muted"}
            aria-hidden
          />
          {stats.currentStreak > 0
            ? `${stats.currentStreak}-day streak`
            : "No streak yet — today starts one"}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <CalendarCheck size={14} aria-hidden />
          {reviewsToday === 1 ? "1 review today" : `${reviewsToday} reviews today`}
        </span>
      </div>
    </Card>
  );
}
