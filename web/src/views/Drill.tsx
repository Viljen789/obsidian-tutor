/**
 * Weak-spot pre-exam drill (/drill).
 *
 * A focused cramming session that runs the learner through their *weakest*
 * concepts — lowest mastery first, more-overdue as the tie-break — one at a
 * time. It's the sharp-edged cousin of scheduled Review: instead of letting the
 * spacing algorithm decide what's due, the learner picks a scope and we drill
 * the soft spots head-on, right before an exam.
 *
 * Three states behind one route, mirroring the Flashcards / Lesson choosers:
 *   • Intro    — a subject scope selector + the ranked weak set, with a CTA.
 *   • Drilling — `<Lesson tone="review">` per concept, a "Weak spot N of M"
 *                header, and a stepper (Next weak spot / Skip).
 *   • Done     — a calm summary ("You drilled N weak spots") + a way back.
 *
 * The drill reuses the existing teach→Q&A→grade loop (`<Lesson>`); it owns only
 * the *selection* and *sequencing* around it. It wears the app's reading-room
 * vocabulary (ui.tsx) and the `review` (amber) tone throughout, since it is a
 * reinforcement experience.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  RotateCcw,
  SkipForward,
  Sparkles,
  Target,
  Zap,
} from "lucide-react";
import type { Concept, Mastery } from "@tutor/shared";
import { useConcepts, useMastery } from "../lib/firestore-hooks";
import { pct } from "../lib/format";
import { selectWeakSpots } from "../lib/weakspots";
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
} from "../components/ui";
import { Lesson } from "../components/Lesson";

const TONE = "review" as const;
/** Sentinel scope meaning "every subject" (the default). */
const ALL = "__all__";
/** How many weak spots a single drill session covers. */
const DRILL_LIMIT = 10;

export function Drill() {
  const concepts = useConcepts();
  const mastery = useMastery();

  // Scope selector: All subjects (default) + each subject the learner has.
  const [scope, setScope] = useState<string>(ALL);
  // The session, once started: a frozen slice of weak concepts + our position.
  // `null` = still on the intro screen choosing a scope.
  const [session, setSession] = useState<Concept[] | null>(null);
  const [index, setIndex] = useState(0);
  // Tally of weak spots actually worked through (advanced or skipped) — drives
  // the completion summary's "You drilled N weak spots".
  const [drilled, setDrilled] = useState(0);

  const all = concepts.data ?? [];
  const masteryMap = mastery.data ?? {};

  // Subjects present, for the scope chips. Sorted, de-duplicated.
  const subjects = useMemo(() => {
    const set = new Set<string>();
    for (const c of all) set.add(c.subject);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [all]);

  // The ranked weak set for the *current* scope. Recomputed as data/scope move;
  // we freeze a copy into `session` at "Start drilling" so live mastery updates
  // mid-drill don't reshuffle the queue under the learner's feet.
  const weak = useMemo(
    () =>
      selectWeakSpots(all, masteryMap, {
        subject: scope === ALL ? undefined : scope,
        limit: DRILL_LIMIT,
      }),
    [all, masteryMap, scope],
  );

  const scopeLabel = scope === ALL ? "all subjects" : scope;

  // --- Loading -------------------------------------------------------------
  if (concepts.isPending || mastery.isPending) return <DrillSkeleton />;

  // --- Errors --------------------------------------------------------------
  if (concepts.isError || mastery.isError) {
    return (
      <Card>
        <ErrorState
          onRetry={() => {
            void concepts.refetch();
            void mastery.refetch();
          }}
        />
      </Card>
    );
  }

  // --- Drilling: run the weak set one concept at a time --------------------
  if (session) {
    const total = session.length;
    const current = session[index];

    // Past the last weak spot → a calm close.
    if (!current) {
      return (
        <DrillSummary
          count={drilled}
          scopeLabel={scopeLabel}
          onAgain={() => {
            setSession(null);
            setIndex(0);
            setDrilled(0);
          }}
        />
      );
    }

    const advance = () => {
      setDrilled((n) => n + 1);
      setIndex((i) => i + 1);
    };

    return (
      <div className="animate-fade">
        <div className="mb-6 flex items-center justify-between">
          <button
            onClick={() => {
              setSession(null);
              setIndex(0);
              setDrilled(0);
            }}
            className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink"
          >
            <ArrowLeft size={15} /> Drill
          </button>
          <span className="flex items-center gap-1.5 text-sm text-muted">
            <Target size={14} className="text-review" />
            Weak spot {index + 1} of {total}
          </span>
        </div>

        {/* Header for this weak spot. */}
        <header className="border-b border-border pb-5">
          <Eyebrow tone={TONE}>
            <span className="inline-flex items-center gap-1.5">
              <Zap size={12} /> Weak spot {index + 1} of {total}
            </span>
          </Eyebrow>
          <h1 className="mt-2 font-serif text-3xl tracking-tight text-ink sm:text-[2.1rem]">
            {current.title}
          </h1>
          <p className="mt-1.5 flex items-center gap-1.5 text-sm text-muted">
            <SubjectDot subject={current.subject} />
            {current.subject}
          </p>
        </header>

        {/* The teaching loop. Remount per concept so all in-flight state
            (explanation, questions, feedback) resets cleanly between drills. */}
        <div className="mt-6">
          <Lesson key={current.id} conceptId={current.id} tone={TONE} />
        </div>

        {/* Stepper — advance to the next weak spot, or skip this one. Skip and
            advance both move the cursor; only the label differs, since "skip"
            means "I didn't drill this" yet still counts as worked-through. */}
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6">
          <button
            onClick={advance}
            className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink"
          >
            <SkipForward size={15} /> Skip
          </button>
          <Button
            tone={TONE}
            icon={index + 1 >= total ? Sparkles : ArrowRight}
            onClick={advance}
          >
            {index + 1 >= total ? "Finish drill" : "Next weak spot"}
          </Button>
        </div>
      </div>
    );
  }

  // --- Intro: scope selector + ranked preview + CTA ------------------------
  const header = (
    <header>
      <Eyebrow tone={TONE}>
        <span className="inline-flex items-center gap-1.5">
          <Target size={12} /> Weak-spot drill
        </span>
      </Eyebrow>
      <h1 className="mt-1.5 font-serif text-[2rem] tracking-tight text-ink">
        Drill your soft spots
      </h1>
      <p className="mt-1 text-[0.95rem] text-muted">
        Targeted cramming before an exam — we line up the concepts you've started
        but know least well, weakest first, and walk you through them.
      </p>
    </header>
  );

  const scopePicker = subjects.length > 0 && (
    <div>
      <Eyebrow>Scope</Eyebrow>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <ScopeChip
          label="All subjects"
          active={scope === ALL}
          onClick={() => setScope(ALL)}
        />
        {subjects.map((s) => (
          <ScopeChip
            key={s}
            label={s}
            subject={s}
            active={scope === s}
            onClick={() => setScope(s)}
          />
        ))}
      </div>
    </div>
  );

  // Nothing to drill in this scope — everything's strong or unstarted.
  if (weak.length === 0) {
    return (
      <div className="animate-fade space-y-7">
        {header}
        {scopePicker}
        <Card>
          <EmptyState
            icon={Target}
            tone={TONE}
            title="No weak spots here"
            description={
              <>
                Nothing in {scopeLabel} is both started and shaky right now —
                either you've got it solid, or you haven't begun it yet. Learn
                something new, or run your scheduled reviews.
              </>
            }
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Link to="/learn">
                  <Button tone="accent">Learn</Button>
                </Link>
                <Link to="/review">
                  <Button variant="secondary" tone="neutral">
                    Review
                  </Button>
                </Link>
              </div>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="animate-fade space-y-7">
      {header}
      {scopePicker}

      <Card className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-serif text-lg text-ink">
            Drilling your {weak.length} weakest in {scopeLabel}
          </h2>
          <p className="mt-1 text-sm text-muted">
            We'll teach and quiz each one in turn — lowest mastery first. Advance
            when you're ready, or skip any you'd rather leave.
          </p>
        </div>
        <Button
          tone={TONE}
          icon={Zap}
          className="shrink-0"
          onClick={() => {
            setSession(weak);
            setIndex(0);
            setDrilled(0);
          }}
        >
          Start drilling
        </Button>
      </Card>

      {/* The ranked weak set — titles + mastery %, weakest at the top. */}
      <section>
        <Eyebrow tone={TONE}>Weakest first</Eyebrow>
        <Card className="mt-3 divide-y divide-border overflow-hidden">
          {weak.map((concept, i) => (
            <WeakRow
              key={concept.id}
              rank={i + 1}
              concept={concept}
              mastery={masteryMap[concept.id]}
            />
          ))}
        </Card>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scope chip — All subjects + one per subject. Active reads in the review tone.
// ---------------------------------------------------------------------------

function ScopeChip({
  label,
  subject,
  active,
  onClick,
}: {
  label: string;
  subject?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors " +
        (active
          ? "border-review/30 bg-review/10 text-review"
          : "border-border bg-surface text-muted hover:bg-ink/[0.03] hover:text-ink")
      }
    >
      {subject && <SubjectDot subject={subject} />}
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// A row in the ranked preview: rank • title • subject • mastery %.
// ---------------------------------------------------------------------------

function WeakRow({
  rank,
  concept,
  mastery,
}: {
  rank: number;
  concept: Concept;
  mastery?: Mastery;
}) {
  const score = mastery?.masteryScore ?? 0;
  return (
    <div className="flex items-center gap-3 px-5 py-3.5">
      <span className="w-5 shrink-0 text-center text-sm tabular-nums text-muted">
        {rank}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[0.95rem] font-medium text-ink">
          {concept.title}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
          <SubjectDot subject={concept.subject} />
          {concept.subject}
        </p>
        <ProgressBar value={score} tone={TONE} className="mt-2 max-w-[14rem]" />
      </div>
      <Pill tone={TONE}>{pct(score)}%</Pill>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Completion summary — a calm close after the last weak spot.
// ---------------------------------------------------------------------------

function DrillSummary({
  count,
  scopeLabel,
  onAgain,
}: {
  count: number;
  scopeLabel: string;
  onAgain: () => void;
}) {
  return (
    <div className="animate-fade">
      <div className="mb-6">
        <Link
          to="/"
          className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink"
        >
          <ArrowLeft size={15} /> Home
        </Link>
      </div>

      <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-review/10 text-review">
          <Sparkles size={22} />
        </div>
        <h2 className="font-serif text-2xl text-ink">Drill complete</h2>
        <p className="max-w-md text-sm leading-relaxed text-muted">
          You drilled {count} weak {count === 1 ? "spot" : "spots"} in {scopeLabel}.
          Each one nudged your mastery and spacing schedule — come back when fresh
          soft spots surface.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button tone={TONE} icon={RotateCcw} onClick={onAgain}>
            Drill again
          </Button>
          <Link to="/review">
            <Button variant="secondary" tone="neutral">
              Go to Review
            </Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton — shown while concepts + mastery load.
// ---------------------------------------------------------------------------

function DrillSkeleton() {
  return (
    <div className="space-y-7">
      <div className="space-y-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-8 w-64" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-8 w-24 rounded-full" />
        <Skeleton className="h-8 w-20 rounded-full" />
        <Skeleton className="h-8 w-20 rounded-full" />
      </div>
      <Skeleton className="h-28 w-full rounded-2xl" />
      <Skeleton className="h-48 w-full rounded-2xl" />
    </div>
  );
}
