/**
 * Shared scaffold for the two teaching modes. Learn and Review are the same
 * underlying loop (explain -> question -> grade -> update) with different
 * framing and accent colour, so they share this page and differ only in the
 * `tone`, copy, and how a concept is chosen when none is given in the URL.
 *
 *   mode "learn"  -> accent (indigo). Routed at /learn and /learn/:conceptId.
 *   mode "review" -> review (amber). Routed at /review and /review/:conceptId.
 *
 * With no :conceptId we ask the adaptive sequencer (api.nextItem) what to do and
 * route into the chosen concept; we also surface a manual picker so the learner
 * keeps agency, and degrade to a calm chooser if the backend is unavailable.
 */
import { useNavigate, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  GraduationCap,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import type { Concept, Mastery, NextItem } from "@tutor/shared";
import { api } from "../lib/api";
import { useConcepts, useMastery } from "../lib/firestore-hooks";
import { isDue, STATUS_LABEL } from "../lib/format";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Eyebrow,
  Pill,
  Skeleton,
  SubjectDot,
} from "../components/ui";
import { Lesson, useLessonResetKey } from "../components/Lesson";

type Mode = "learn" | "review";

const COPY: Record<
  Mode,
  { tone: "accent" | "review"; eyebrow: string; title: string; icon: typeof GraduationCap }
> = {
  learn: {
    tone: "accent",
    eyebrow: "Learn",
    title: "Learn something new",
    icon: GraduationCap,
  },
  review: {
    tone: "review",
    eyebrow: "Review",
    title: "Review what's fading",
    icon: RotateCcw,
  },
};

export function LessonPage({ mode }: { mode: Mode }) {
  const { conceptId } = useParams<{ conceptId?: string }>();
  if (conceptId) return <ActiveLesson mode={mode} conceptId={conceptId} />;
  return <Chooser mode={mode} />;
}

// ---------------------------------------------------------------------------
// An active lesson for a specific concept.
// ---------------------------------------------------------------------------

function ActiveLesson({ mode, conceptId }: { mode: Mode; conceptId: string }) {
  const navigate = useNavigate();
  const copy = COPY[mode];
  const { key, reset, Icon: ResetIcon } = useLessonResetKey(conceptId);

  return (
    <div className="animate-fade">
      <div className="mb-6 flex items-center justify-between">
        <button
          onClick={() => navigate(mode === "learn" ? "/learn" : "/review")}
          className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink"
        >
          <ArrowLeft size={15} />
          {copy.eyebrow}
        </button>
        <button
          onClick={reset}
          className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink"
        >
          <ResetIcon size={14} /> Start over
        </button>
      </div>

      {/* Remount on reset so a fresh attempt clears all in-flight state. */}
      <Lesson key={key} conceptId={conceptId} tone={copy.tone} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The chooser shown at /learn and /review with no concept selected.
// ---------------------------------------------------------------------------

function Chooser({ mode }: { mode: Mode }) {
  const navigate = useNavigate();
  const copy = COPY[mode];
  const concepts = useConcepts();
  const mastery = useMastery();

  const next = useMutation({
    mutationFn: (): Promise<NextItem> => api.nextItem({}),
    onSuccess: (item) => {
      // Only route if the sequencer's action matches the mode the learner chose.
      if (item.conceptId && item.action === mode) {
        navigate(`/${mode}/${item.conceptId}`);
      }
    },
  });

  const loading = concepts.isPending || mastery.isPending;
  const masteryMap = mastery.data ?? {};
  const all = concepts.data ?? [];

  // Learn surfaces new/learning concepts; Review surfaces due ones.
  const candidates: { concept: Concept; mastery?: Mastery; locked?: boolean }[] =
    mode === "review"
      ? all
          .map((c) => ({ concept: c, mastery: masteryMap[c.id] }))
          .filter((x) => x.mastery && isDue(x.mastery.dueDate))
      : all
          .map((c) => ({ concept: c, mastery: masteryMap[c.id] }))
          .filter((x) => {
            const s = x.mastery?.status;
            return !s || s === "new" || s === "learning";
          });

  if (loading) return <ChooserSkeleton />;

  if (concepts.isError) {
    return (
      <Card>
        <ErrorState onRetry={() => void concepts.refetch()} />
      </Card>
    );
  }

  if (all.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={copy.icon}
          tone={copy.tone}
          title="Nothing to study yet"
          description="Import an Obsidian vault first — then your concepts will appear here."
          action={
            <Button tone={copy.tone} onClick={() => navigate("/import")}>
              Import a vault
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <div className="animate-fade space-y-7">
      <header>
        <Eyebrow tone={copy.tone}>{copy.eyebrow}</Eyebrow>
        <h1 className="mt-1.5 font-serif text-[2rem] tracking-tight text-ink">{copy.title}</h1>
        <p className="mt-1 text-[0.95rem] text-muted">
          {mode === "review"
            ? "Concepts the spacing schedule says are ready to revisit."
            : "Let the tutor choose the next concept, or pick one yourself."}
        </p>
      </header>

      <Card className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-serif text-lg text-ink">
            {mode === "review" ? "Begin your reviews" : "Follow the path"}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {next.data?.action === "none"
              ? next.data.reason
              : mode === "review"
                ? "Start with the concept most in need of reinforcement."
                : "The next unlocked concept, chosen from your prerequisites."}
          </p>
        </div>
        {next.data?.action !== "none" && (
          <Button
            tone={copy.tone}
            icon={Sparkles}
            loading={next.isPending}
            onClick={() => next.mutate()}
            className="shrink-0"
          >
            {mode === "review" ? "Start reviewing" : "Start learning"}
          </Button>
        )}
      </Card>

      {candidates.length === 0 ? (
        <EmptyState
          icon={copy.icon}
          tone={copy.tone}
          title={mode === "review" ? "No reviews due" : "Nothing new unlocked"}
          description={
            mode === "review"
              ? "You're caught up. Reviews will reappear as concepts fade from memory."
              : "Every available concept is in progress. Finish or review those, or import more material."
          }
          action={
            <Button
              variant="secondary"
              tone="neutral"
              onClick={() => navigate(mode === "review" ? "/learn" : "/review")}
            >
              {mode === "review" ? "Learn instead" : "Review instead"}
            </Button>
          }
        />
      ) : (
        <section>
          <Eyebrow>{mode === "review" ? "Due now" : "Available concepts"}</Eyebrow>
          <Card className="mt-3 divide-y divide-border overflow-hidden">
            {candidates.slice(0, 12).map(({ concept, mastery: m }) => (
              <ConceptRow
                key={concept.id}
                concept={concept}
                mastery={m}
                tone={copy.tone}
                onClick={() => navigate(`/${mode}/${concept.id}`)}
              />
            ))}
          </Card>
        </section>
      )}
    </div>
  );
}

function ConceptRow({
  concept,
  mastery: m,
  tone,
  onClick,
}: {
  concept: Concept;
  mastery?: Mastery;
  tone: "accent" | "review";
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "group flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors " +
        (tone === "review" ? "hover:bg-review/[0.05]" : "hover:bg-accent/[0.04]")
      }
    >
      <div className="min-w-0">
        <p className="truncate text-[0.95rem] font-medium text-ink">{concept.title}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
          <SubjectDot subject={concept.subject} />
          {concept.subject}
        </p>
      </div>
      {m?.status && <Pill tone="neutral">{STATUS_LABEL[m.status]}</Pill>}
    </button>
  );
}

function ChooserSkeleton() {
  return (
    <div className="space-y-7">
      <div className="space-y-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-8 w-64" />
      </div>
      <Skeleton className="h-28 w-full rounded-2xl" />
      <Skeleton className="h-48 w-full rounded-2xl" />
    </div>
  );
}
