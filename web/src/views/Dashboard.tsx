/**
 * Dashboard (/): the learner's home. Three movements, top to bottom —
 *   1. A primary "what now" call to action driven by the adaptive sequencer
 *      (api.nextItem) that routes into Learn or Review with the right framing.
 *   2. "Due for review" — every concept whose dueDate has passed, surfaced as a
 *      list with a one-tap entry into review.
 *   3. A mastery overview grouped by subject, with quiet progress bars.
 * Plus an always-available vault-import entry point. First-time users (no
 * concepts) get a focused empty state that points straight at import.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Library, Trash2, Upload, Zap } from "lucide-react";
import type { Concept, Mastery } from "@tutor/shared";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { qk, useConcepts, useMastery } from "../lib/firestore-hooks";
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
import { DailyQueue } from "../components/DailyQueue";
import { ReadinessPanel } from "../components/ReadinessPanel";
import { ShareButton } from "../components/ShareButton";
import { AnkiExportButton } from "../components/AnkiExportButton";
import { ShareToFriendButton } from "../components/ShareToFriendButton";
import { Inbox } from "../components/Inbox";
import { dueLabel, isDue, pct, STATUS_LABEL } from "../lib/format";

interface SubjectGroup {
  subject: string;
  concepts: { concept: Concept; mastery?: Mastery }[];
  avg: number;
  mastered: number;
}

export function Dashboard() {
  const navigate = useNavigate();
  const concepts = useConcepts();
  const mastery = useMastery();

  const loading = concepts.isPending || mastery.isPending;
  const hasError = concepts.isError; // mastery may legitimately be empty/erroring early

  const masteryMap = mastery.data ?? {};

  const due = useMemo(() => {
    const list = Object.values(masteryMap).filter((m) => isDue(m.dueDate));
    list.sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
    return list;
  }, [masteryMap]);

  const byConceptId = useMemo(() => {
    const map: Record<string, Concept> = {};
    for (const c of concepts.data ?? []) map[c.id] = c;
    return map;
  }, [concepts.data]);

  const groups = useMemo<SubjectGroup[]>(() => {
    const bySubject = new Map<string, SubjectGroup>();
    for (const c of concepts.data ?? []) {
      const g =
        bySubject.get(c.subject) ??
        ({ subject: c.subject, concepts: [], avg: 0, mastered: 0 } as SubjectGroup);
      g.concepts.push({ concept: c, mastery: masteryMap[c.id] });
      bySubject.set(c.subject, g);
    }
    const out = [...bySubject.values()];
    for (const g of out) {
      const scores = g.concepts.map((x) => x.mastery?.masteryScore ?? 0);
      g.avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      g.mastered = g.concepts.filter((x) => x.mastery?.status === "mastered").length;
    }
    out.sort((a, b) => a.subject.localeCompare(b.subject));
    return out;
  }, [concepts.data, masteryMap]);

  if (loading) return <DashboardSkeleton />;

  if (hasError) {
    return (
      <Card>
        <ErrorState
          title="We couldn't reach your library"
          description="Your concepts didn't load. This often clears up on a retry."
          onRetry={() => void concepts.refetch()}
        />
      </Card>
    );
  }

  const empty = (concepts.data?.length ?? 0) === 0;
  if (empty) {
    return (
      <div className="animate-fade">
        <PageHeader title="Welcome" subtitle="Let's get your material in." />
        <Card className="mt-6">
          <EmptyState
            icon={Library}
            tone="accent"
            title="Your library is empty"
            description="Import an Obsidian vault to begin. The tutor turns your notes into a graph of concepts, then teaches them in the right order."
            action={
              <Button icon={Upload} onClick={() => navigate("/import")}>
                Import a vault
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="animate-fade space-y-10">
      <PageHeader
        title="Today"
        subtitle={
          due.length > 0
            ? `${due.length} concept${due.length === 1 ? "" : "s"} ready for review.`
            : "Nothing due — a good moment to learn something new."
        }
      />

      <Inbox />

      <DailyQueue />

      <ReadinessPanel />

      <button
        onClick={() => navigate("/drill")}
        className="group flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-5 py-4 text-left transition-colors hover:bg-review/[0.04]"
      >
        <span className="flex items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-review/10 text-review">
            <Zap size={17} />
          </span>
          <span className="min-w-0">
            <span className="block text-[0.95rem] font-medium text-ink">Drill your weak spots</span>
            <span className="block text-xs text-muted">A focused session on your shakiest concepts.</span>
          </span>
        </span>
        <ArrowRight size={16} className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
      </button>

      <DueSection
        due={due}
        byConceptId={byConceptId}
        onReview={(id) => navigate(`/learn/${id}`)}
      />

      <section>
        <div className="mb-3 flex items-center justify-between">
          <Eyebrow>Your subjects</Eyebrow>
          <button
            onClick={() => navigate("/import")}
            className="flex items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-ink"
          >
            <Upload size={13} /> Import more
          </button>
        </div>
        <div className="space-y-3">
          {groups.map((g) => (
            <SubjectCard key={g.subject} group={g} onOpen={() => navigate("/progress")} />
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header>
      <h1 className="font-serif text-[2rem] tracking-tight text-ink">{title}</h1>
      <p className="mt-1 text-[0.95rem] text-muted">{subtitle}</p>
    </header>
  );
}

function DueSection({
  due,
  byConceptId,
  onReview,
}: {
  due: Mastery[];
  byConceptId: Record<string, Concept>;
  onReview: (conceptId: string) => void;
}) {
  if (due.length === 0) {
    return (
      <section>
        <Eyebrow tone="review">Due for review</Eyebrow>
        <Card className="mt-3 px-5 py-6 text-center">
          <p className="text-sm text-muted">
            Nothing's due right now. Reviews appear here as your memory of past
            concepts starts to fade.
          </p>
        </Card>
      </section>
    );
  }

  const shown = due.slice(0, 6);
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Eyebrow tone="review">Due for review</Eyebrow>
        <Pill tone="review">{due.length}</Pill>
      </div>
      <Card className="divide-y divide-border overflow-hidden">
        {shown.map((m) => {
          const c = byConceptId[m.conceptId];
          return (
            <button
              key={m.conceptId}
              onClick={() => onReview(m.conceptId)}
              className="group flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors hover:bg-review/[0.05]"
            >
              <div className="min-w-0">
                <p className="truncate text-[0.95rem] font-medium text-ink">
                  {c?.title ?? m.conceptId}
                </p>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                  {c && <SubjectDot subject={c.subject} />}
                  {c?.subject ?? "Concept"} · {dueLabel(m.dueDate)}
                </p>
              </div>
              <ArrowRight
                size={16}
                className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5"
              />
            </button>
          );
        })}
        {due.length > shown.length && (
          <div className="px-5 py-2.5 text-xs text-muted">
            + {due.length - shown.length} more due
          </div>
        )}
      </Card>
    </section>
  );
}

function SubjectCard({ group, onOpen }: { group: SubjectGroup; onOpen: () => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const count = group.concepts.length;

  const del = useMutation({
    mutationFn: () => api.deleteSubject({ subject: group.subject }),
    onSuccess: () => {
      // The subject's concepts + mastery no longer exist server-side; refetch
      // both so the row disappears and the totals above update.
      const uid = user?.uid ?? "anon";
      void qc.invalidateQueries({ queryKey: qk.concepts(uid) });
      void qc.invalidateQueries({ queryKey: qk.mastery(uid) });
    },
  });

  // The confirmation replaces the row in place — a calm, modal-free affordance.
  if (confirming) {
    return (
      <Card className="border-red-500/30 bg-red-500/[0.02]">
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-[0.95rem] font-medium text-ink">
              Delete{" "}
              <span className="font-semibold">
                {count} concept{count === 1 ? "" : "s"}
              </span>{" "}
              in {group.subject}?
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">
              {del.isError
                ? "That didn't go through. Please try again."
                : "This removes the concepts and all your progress on them. It can't be undone."}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              tone="neutral"
              size="sm"
              disabled={del.isPending}
              onClick={() => {
                del.reset();
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              loading={del.isPending}
              onClick={() => del.mutate()}
              className="bg-red-600 text-white hover:opacity-90 focus-visible:ring-red-600/40"
            >
              {del.isPending ? "Deleting" : del.isError ? "Try again" : "Delete"}
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="group/card relative">
      <button
        onClick={onOpen}
        className="flex w-full items-center gap-4 px-5 py-4 pr-12 text-left transition-colors hover:bg-ink/[0.02]"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <SubjectDot subject={group.subject} />
            <h3 className="truncate font-medium text-ink">{group.subject}</h3>
            <span className="text-xs text-muted">
              {count} concept{count === 1 ? "" : "s"}
            </span>
          </div>
          <div className="mt-2.5 flex items-center gap-3">
            <ProgressBar value={group.avg} className="max-w-xs" />
            <span className="shrink-0 text-xs tabular-nums text-muted">{pct(group.avg)}%</span>
          </div>
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          <p className="text-sm font-medium text-ink">{group.mastered}</p>
          <p className="text-[0.7rem] uppercase tracking-wide text-muted">{STATUS_LABEL.mastered}</p>
        </div>
      </button>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-2">
        <ShareButton subject={group.subject} />
        <ShareToFriendButton subject={group.subject} />
        <AnkiExportButton subject={group.subject} />
      </div>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        aria-label={`Delete ${group.subject} and its ${count} concept${count === 1 ? "" : "s"}`}
        title={`Delete ${group.subject}`}
        className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-lg text-muted opacity-0 transition-all hover:bg-red-500/10 hover:text-red-600 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600/40 group-hover/card:opacity-100"
      >
        <Trash2 size={15} />
      </button>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-10">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <Skeleton className="h-40 w-full rounded-2xl" />
      <div className="space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-16 w-full rounded-2xl" />
        <Skeleton className="h-16 w-full rounded-2xl" />
      </div>
    </div>
  );
}
