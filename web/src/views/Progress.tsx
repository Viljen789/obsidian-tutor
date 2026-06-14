/**
 * Progress (/progress): the learner model made legible. A compact summary strip
 * (counts by status, total reviews), then every concept grouped by subject with
 * its mastery score, spaced-repetition state (status, due date, ease factor,
 * interval, repetitions), and an expandable recent-quality history. Concepts the
 * learner hasn't touched read as "new" with empty SR state, so the page is
 * honest about what's been practised versus merely imported.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Sprout, TrendingUp } from "lucide-react";
import { clsx } from "clsx";
import type { Concept, Mastery, MasteryStatus } from "@tutor/shared";
import { useConcepts, useMastery } from "../lib/firestore-hooks";
import { dueLabel, pct, shortDate, STATUS_LABEL } from "../lib/format";
import { collectTags, filterByTags } from "../lib/tags";
import {
  reviewHeatmap,
  reviewStreakStats,
  statusBreakdown,
  subjectMastery,
  type HeatmapCell,
  type ReviewStreakStats,
  type StatusCount,
  type SubjectMastery,
} from "../lib/analytics";
import { TagFilter } from "../components/TagFilter";
import { Heatmap } from "../components/Heatmap";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Eyebrow,
  Pill,
  ProgressBar,
  Skeleton,
  SubjectDot,
  type Tone,
} from "../components/ui";

/** Trailing window for the review heatmap — 17 weeks reads as a tidy grid. */
const HEATMAP_DAYS = 119;

const STATUS_TONE: Record<MasteryStatus, Tone> = {
  new: "neutral",
  learning: "accent",
  review: "review",
  mastered: "accent",
};

export function Progress() {
  const navigate = useNavigate();
  const concepts = useConcepts();
  const mastery = useMastery();

  const masteryMap = mastery.data ?? {};
  const all = concepts.data ?? [];

  // Tag filter (OR/ANY semantics — see lib/tags). State holds first-spelling
  // tags; an empty set means "no filter".
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());

  // Distinct tags (with counts) over the *full* concept list — the filter bar
  // shows every tag regardless of the current selection.
  const allTags = useMemo(() => collectTags(all), [all]);

  // Concepts narrowed to the active tag selection (all of them when empty).
  const filtered = useMemo(() => filterByTags(all, selectedTags), [all, selectedTags]);

  const toggleTag = (tag: string) =>
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });

  const clearTags = () => setSelectedTags(new Set());

  const rows = useMemo(
    () =>
      filtered
        .map((concept) => ({ concept, mastery: masteryMap[concept.id] }))
        .sort(
          (a, b) =>
            a.concept.subject.localeCompare(b.concept.subject) ||
            (b.mastery?.masteryScore ?? 0) - (a.mastery?.masteryScore ?? 0) ||
            a.concept.title.localeCompare(b.concept.title),
        ),
    [filtered, masteryMap],
  );

  const stats = useMemo(() => {
    const counts: Record<MasteryStatus, number> = {
      new: 0,
      learning: 0,
      review: 0,
      mastered: 0,
    };
    let reviews = 0;
    for (const { concept } of rows) {
      const m = masteryMap[concept.id];
      counts[m?.status ?? "new"]++;
      reviews += m?.history?.length ?? 0;
    }
    return { counts, reviews, total: rows.length };
  }, [rows, masteryMap]);

  const groups = useMemo(() => {
    const map = new Map<string, { concept: Concept; mastery?: Mastery }[]>();
    for (const row of rows) {
      const arr = map.get(row.concept.subject) ?? [];
      arr.push(row);
      map.set(row.concept.subject, arr);
    }
    return [...map.entries()];
  }, [rows]);

  // Analytics derive from the *full, unfiltered* learner model: momentum is
  // about overall study activity, not whatever tag slice is currently selected.
  const heatmap = useMemo(() => reviewHeatmap(masteryMap, { days: HEATMAP_DAYS }), [masteryMap]);
  const streak = useMemo(() => reviewStreakStats(heatmap), [heatmap]);
  const breakdown = useMemo(() => statusBreakdown(all, masteryMap), [all, masteryMap]);
  const subjects = useMemo(() => subjectMastery(all, masteryMap), [all, masteryMap]);

  if (concepts.isPending || mastery.isPending) return <ProgressSkeleton />;

  if (concepts.isError) {
    return (
      <Card>
        <ErrorState onRetry={() => void concepts.refetch()} />
      </Card>
    );
  }

  if (all.length === 0) {
    return (
      <div className="animate-fade">
        <Header />
        <Card className="mt-6">
          <EmptyState
            icon={Sprout}
            title="No progress to chart yet"
            description="Once you import a vault and start learning, your mastery and review schedule appear here."
            action={<Button onClick={() => navigate("/import")}>Import a vault</Button>}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="animate-fade space-y-8">
      <Header />

      {/* Tag filter — only rendered when at least one concept carries a tag. */}
      {allTags.length > 0 && (
        <TagFilter
          tags={allTags}
          selected={selectedTags}
          onToggle={toggleTag}
          onClear={clearTags}
        />
      )}

      {/* Summary strip — reflects the active filter. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Concepts" value={stats.total} />
        <Stat label={STATUS_LABEL.mastered} value={stats.counts.mastered} tone="accent" />
        <Stat
          label="In progress"
          value={stats.counts.learning + stats.counts.review}
          tone="review"
        />
        <Stat label="Reviews done" value={stats.reviews} />
      </div>

      {/* Your momentum — review activity + mastery shape, over the whole vault.
          Independent of the tag filter above, which only narrows the list below. */}
      <MomentumSection
        heatmap={heatmap}
        streak={streak}
        breakdown={breakdown}
        subjects={subjects}
        totalConcepts={all.length}
      />

      {groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={Sprout}
            title="No concepts match this filter"
            description="No concepts carry the selected tags. Clear the filter to see everything again."
            action={
              <Button variant="secondary" tone="neutral" onClick={clearTags}>
                Clear filter
              </Button>
            }
          />
        </Card>
      ) : (
        groups.map(([subject, items]) => (
          <section key={subject}>
            <div className="mb-3 flex items-center gap-2">
              <SubjectDot subject={subject} />
              <Eyebrow>{subject}</Eyebrow>
              <span className="text-xs text-muted">{items.length}</span>
            </div>
            <Card className="divide-y divide-border overflow-hidden">
              {items.map(({ concept, mastery: m }) => (
                <ConceptProgressRow key={concept.id} concept={concept} mastery={m} />
              ))}
            </Card>
          </section>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Header() {
  return (
    <header className="flex items-center gap-3">
      <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent">
        <TrendingUp size={20} />
      </div>
      <div>
        <h1 className="font-serif text-[2rem] leading-none tracking-tight text-ink">Progress</h1>
        <p className="mt-1 text-[0.95rem] text-muted">
          Your mastery and spaced-repetition schedule, concept by concept.
        </p>
      </div>
    </header>
  );
}

function Stat({ label, value, tone = "neutral" }: { label: string; value: number; tone?: Tone }) {
  const color =
    tone === "accent" ? "text-accent" : tone === "review" ? "text-review" : "text-ink";
  return (
    <Card className="px-4 py-3.5">
      <p className={clsx("font-serif text-2xl tabular-nums", color)}>{value}</p>
      <p className="mt-0.5 text-xs text-muted">{label}</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Your momentum — analytics block: review heatmap, status breakdown, and a
// per-subject mastery summary. All computed from the full learner model.
// ---------------------------------------------------------------------------

function MomentumSection({
  heatmap,
  streak,
  breakdown,
  subjects,
  totalConcepts,
}: {
  heatmap: HeatmapCell[];
  streak: ReviewStreakStats;
  breakdown: StatusCount[];
  subjects: SubjectMastery[];
  totalConcepts: number;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-xl text-ink">Your momentum</h2>
        <Eyebrow>Last 17 weeks</Eyebrow>
      </div>

      {/* Review heatmap + at-a-glance activity totals. */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          <MomentumStat label="Reviews" value={streak.totalReviews} />
          <MomentumStat label="Active days" value={streak.activeDays} />
          <MomentumStat label="Best day" value={streak.bestDay} />
          <MomentumStat label="Day streak" value={streak.currentStreak} tone="accent" />
        </div>
        <div className="mt-4">
          <Heatmap data={heatmap} />
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Mastery breakdown by status. */}
        <Card className="p-5">
          <Eyebrow>Mastery breakdown</Eyebrow>
          <StatusBreakdownRow breakdown={breakdown} total={totalConcepts} />
        </Card>

        {/* Per-subject mastery summary. */}
        <Card className="p-5">
          <Eyebrow>By subject</Eyebrow>
          {subjects.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No subjects yet.</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {subjects.map((s) => (
                <SubjectMasteryRow key={s.subject} item={s} />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </section>
  );
}

function MomentumStat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: Tone;
}) {
  const color = tone === "accent" ? "text-accent" : tone === "review" ? "text-review" : "text-ink";
  return (
    <div>
      <p className={clsx("font-serif text-xl tabular-nums", color)}>{Math.round(value)}</p>
      <p className="text-[0.7rem] uppercase tracking-wide text-muted">{label}</p>
    </div>
  );
}

/** A single stacked bar of status proportions, with a labelled legend below. */
function StatusBreakdownRow({ breakdown, total }: { breakdown: StatusCount[]; total: number }) {
  const sum = breakdown.reduce((acc, b) => acc + b.count, 0);
  const present = breakdown.filter((b) => b.count > 0);

  const fillFor = (status: MasteryStatus): string =>
    status === "mastered" || status === "learning"
      ? "bg-accent"
      : status === "review"
        ? "bg-review"
        : "bg-ink/20";

  return (
    <div className="mt-3">
      {/* Proportional bar — a quiet, single-row stacked summary. */}
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-ink/[0.06]"
        role="img"
        aria-label={`Mastery breakdown across ${Math.round(total)} concepts`}
      >
        {sum > 0 &&
          present.map((b) => (
            <div
              key={b.status}
              className={clsx("h-full first:rounded-l-full last:rounded-r-full", fillFor(b.status))}
              style={{ width: `${(b.count / sum) * 100}%` }}
            />
          ))}
      </div>

      {/* Legend with raw counts. */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
        {breakdown.map((b) => (
          <span key={b.status} className="inline-flex items-center gap-1.5">
            <Pill tone={STATUS_TONE[b.status]}>{STATUS_LABEL[b.status]}</Pill>
            <span className="text-sm tabular-nums text-ink">{b.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function SubjectMasteryRow({ item }: { item: SubjectMastery }) {
  return (
    <li>
      <div className="flex items-center gap-2">
        <SubjectDot subject={item.subject} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {item.subject}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted">
          {item.mastered}/{item.total} mastered
        </span>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <ProgressBar value={item.avg} className="max-w-none" />
        <span className="shrink-0 text-xs tabular-nums text-muted">{pct(item.avg)}%</span>
      </div>
    </li>
  );
}

function ConceptProgressRow({
  concept,
  mastery: m,
}: {
  concept: Concept;
  mastery?: Mastery;
}) {
  const [open, setOpen] = useState(false);
  const status = m?.status ?? "new";
  const score = m?.masteryScore ?? 0;
  const history = m?.history ?? [];
  const hasHistory = history.length > 0;

  return (
    <div>
      <button
        onClick={() => hasHistory && setOpen((o) => !o)}
        className={clsx(
          "flex w-full items-center gap-4 px-5 py-4 text-left transition-colors",
          hasHistory ? "hover:bg-ink/[0.02]" : "cursor-default",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[0.95rem] font-medium text-ink">{concept.title}</p>
            <Pill tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <ProgressBar
              value={score}
              tone={status === "review" ? "review" : status === "new" ? "neutral" : "accent"}
              className="max-w-[12rem]"
            />
            <span className="shrink-0 text-xs tabular-nums text-muted">{pct(score)}%</span>
          </div>
          {concept.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {concept.tags.map((tag) => (
                <Pill key={tag} tone="neutral">
                  <span className="opacity-60">#</span>
                  {tag}
                </Pill>
              ))}
            </div>
          )}
        </div>

        <div className="hidden shrink-0 items-center gap-5 text-right sm:flex">
          <SrStat label="Due" value={m?.dueDate ? dueLabel(m.dueDate) : "—"} />
          <SrStat label="Ease" value={m ? m.easeFactor.toFixed(2) : "—"} />
          <SrStat
            label="Interval"
            value={m && m.intervalDays > 0 ? `${m.intervalDays}d` : "—"}
          />
        </div>

        {hasHistory && (
          <ChevronDown
            size={16}
            className={clsx(
              "shrink-0 text-muted transition-transform",
              open && "rotate-180",
            )}
          />
        )}
      </button>

      {open && hasHistory && (
        <div className="animate-rise border-t border-border bg-bg/40 px-5 py-4">
          <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1.5 text-xs text-muted sm:hidden">
            <span>Due {m?.dueDate ? dueLabel(m.dueDate) : "—"}</span>
            <span>Ease {m ? m.easeFactor.toFixed(2) : "—"}</span>
            <span>Interval {m && m.intervalDays > 0 ? `${m.intervalDays}d` : "—"}</span>
            <span>Reps {m?.repetitions ?? 0}</span>
          </div>
          <Eyebrow>Recent answers</Eyebrow>
          <ul className="mt-2 space-y-1.5">
            {[...history]
              .slice(-6)
              .reverse()
              .map((h, i) => (
                <li key={i} className="flex items-center gap-3 text-sm">
                  <QualityDots quality={h.quality} />
                  <span className="text-muted">{shortDate(h.date)}</span>
                  {h.note && <span className="truncate text-muted/80">· {h.note}</span>}
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SrStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[0.7rem] uppercase tracking-wide text-muted">{label}</p>
      <p className="text-sm tabular-nums text-ink">{value}</p>
    </div>
  );
}

function QualityDots({ quality }: { quality: number }) {
  const q = Math.max(0, Math.min(5, Math.round(quality)));
  return (
    <span className="flex gap-0.5" aria-label={`Quality ${q} of 5`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={clsx(
            "h-1.5 w-1.5 rounded-full",
            i < q ? (q >= 3 ? "bg-accent" : "bg-review") : "bg-ink/15",
          )}
        />
      ))}
    </span>
  );
}

function ProgressSkeleton() {
  return (
    <div className="space-y-8">
      <Skeleton className="h-12 w-56" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 rounded-2xl" />
        ))}
      </div>
      {/* Momentum block placeholder. */}
      <div className="space-y-4">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-44 w-full rounded-2xl" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-32 rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
        </div>
      </div>
      <Skeleton className="h-64 w-full rounded-2xl" />
    </div>
  );
}
