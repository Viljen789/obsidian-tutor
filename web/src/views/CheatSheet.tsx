/**
 * Cheat sheet mode (/cheatsheet, /cheatsheet/:subject) — distil a whole subject
 * into ONE dense, print-friendly revision sheet.
 *
 * The learner picks a subject; the backend (api.generateCheatSheet) condenses
 * that subject's concepts — definitions, formulas, key facts — into a tight,
 * one-page Markdown sheet, cached per subject so it's instant on repeat visits.
 * We render it in the reading column with the shared <Markdown> (LaTeX + code,
 * but no wikilinks — a cheat sheet is self-contained), and give it a Print
 * button (window.print()) plus a Regenerate action.
 *
 * It shares the app's reading-room vocabulary (ui.tsx primitives) but wears a
 * "revision card" framing. Accent tone keeps it on-brand. Every stage degrades
 * gracefully: no subjects, generation failure, and an empty sheet are handled.
 */
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  FileText,
  Printer,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import type { Concept } from "@tutor/shared";
import { api } from "../lib/api";
import { useConcepts } from "../lib/firestore-hooks";
import { Markdown } from "../components/Markdown";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Eyebrow,
  Pill,
  Skeleton,
  Spinner,
  SubjectDot,
} from "../components/ui";

const TONE = "accent" as const;

export function CheatSheet() {
  const { subject } = useParams<{ subject?: string }>();
  if (subject) return <CheatSheetView subject={decodeURIComponent(subject)} />;
  return <SubjectChooser />;
}

// ---------------------------------------------------------------------------
// Subject chooser — shown at /cheatsheet with no subject selected.
// ---------------------------------------------------------------------------

function SubjectChooser() {
  const navigate = useNavigate();
  const concepts = useConcepts();

  const subjects = useMemo(
    () => summariseSubjects(concepts.data ?? []),
    [concepts.data],
  );

  if (concepts.isPending) return <ChooserSkeleton />;

  if (concepts.isError) {
    return (
      <Card>
        <ErrorState onRetry={() => void concepts.refetch()} />
      </Card>
    );
  }

  if (subjects.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={FileText}
          tone={TONE}
          title="No subjects to revise yet"
          description="Import an Obsidian vault first — then you can distil any subject in it into a one-page cheat sheet."
          action={
            <Button tone={TONE} onClick={() => navigate("/import")}>
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
        <Eyebrow tone={TONE}>Cheat sheet</Eyebrow>
        <h1 className="mt-1.5 font-serif text-[2rem] tracking-tight text-ink">
          Distil a subject to one page
        </h1>
        <p className="mt-1 text-[0.95rem] text-muted">
          Pick a subject. We'll condense its concepts into a dense,
          print-friendly revision sheet — key definitions, formulas, and the
          facts worth carrying into the exam.
        </p>
      </header>

      <section>
        <Eyebrow>Choose a subject</Eyebrow>
        <Card className="mt-3 divide-y divide-border overflow-hidden">
          {subjects.map((s) => (
            <button
              key={s.subject}
              onClick={() => navigate(`/cheatsheet/${encodeURIComponent(s.subject)}`)}
              className="group flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-accent/[0.04]"
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 truncate text-[0.97rem] font-medium text-ink">
                  <SubjectDot subject={s.subject} />
                  {s.subject}
                </p>
                <p className="mt-0.5 pl-4 text-xs text-muted">
                  {s.count} {s.count === 1 ? "concept" : "concepts"}
                </p>
              </div>
              <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted transition-colors group-hover:text-accent">
                Build
                <ArrowRight size={15} />
              </span>
            </button>
          ))}
        </Card>
      </section>
    </div>
  );
}

interface SubjectSummary {
  subject: string;
  count: number;
}

function summariseSubjects(concepts: Concept[]): SubjectSummary[] {
  const counts = new Map<string, number>();
  for (const c of concepts) counts.set(c.subject, (counts.get(c.subject) ?? 0) + 1);
  return [...counts.entries()]
    .map(([subject, count]) => ({ subject, count }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

// ---------------------------------------------------------------------------
// Cheat sheet view — generates (or serves cached) the sheet, then renders it.
// ---------------------------------------------------------------------------

function CheatSheetView({ subject }: { subject: string }) {
  const navigate = useNavigate();

  const sheet = useQuery({
    queryKey: ["cheatsheet", subject],
    retry: 0,
    queryFn: () => api.generateCheatSheet({ subject }),
  });

  const back = (
    <button
      onClick={() => navigate("/cheatsheet")}
      className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink print:hidden"
    >
      <ArrowLeft size={15} /> Cheat sheets
    </button>
  );

  // Generating the sheet.
  if (sheet.isPending) {
    return (
      <div className="animate-fade">
        <div className="mb-6">{back}</div>
        <SheetHeader subject={subject} />
        <Card className="mt-6 space-y-4 p-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-10/12" />
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-9/12" />
          <Spinner label="Distilling the subject onto one page…" />
        </Card>
      </div>
    );
  }

  if (sheet.isError) {
    return (
      <div className="animate-fade">
        <div className="mb-6">{back}</div>
        <SheetHeader subject={subject} />
        <Card className="mt-6">
          <ErrorState
            title="Couldn't build the cheat sheet"
            description="The distiller is unavailable just now. Give it another moment, or pick a different subject."
            onRetry={() => void sheet.refetch()}
          />
        </Card>
      </div>
    );
  }

  const markdown = sheet.data.markdown.trim();

  if (!markdown) {
    return (
      <div className="animate-fade">
        <div className="mb-6">{back}</div>
        <SheetHeader subject={subject} />
        <Card className="mt-6">
          <EmptyState
            icon={FileText}
            tone={TONE}
            title="Nothing to condense yet"
            description="We couldn't distil a sheet for this subject. Try again, or choose another subject."
            action={
              <Button tone={TONE} onClick={() => void sheet.refetch()}>
                Try again
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  // The rendered sheet.
  return (
    <div className="animate-fade pb-12">
      <div className="mb-6 print:hidden">{back}</div>

      <SheetHeader
        subject={subject}
        cached={sheet.data.cached}
        actions={
          <>
            <Button
              variant="secondary"
              tone="neutral"
              size="sm"
              icon={RotateCcw}
              loading={sheet.isFetching}
              onClick={() => void sheet.refetch()}
            >
              Regenerate
            </Button>
            <Button
              tone={TONE}
              size="sm"
              icon={Printer}
              onClick={() => window.print()}
            >
              Print
            </Button>
          </>
        }
      />

      <Card className="mt-6 p-6 sm:p-8 print:border-0 print:bg-transparent print:p-0">
        <Markdown className="cheatsheet-print">{markdown}</Markdown>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sheet header — a "revision card" masthead. Actions hide when printing.
// ---------------------------------------------------------------------------

function SheetHeader({
  subject,
  cached,
  actions,
}: {
  subject: string;
  cached?: boolean;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Eyebrow tone={TONE}>
            <span className="inline-flex items-center gap-1.5">
              <Sparkles size={12} />
              Cheat sheet
            </span>
          </Eyebrow>
          {cached && (
            <Pill tone="neutral" className="print:hidden">
              Saved
            </Pill>
          )}
        </div>
        <h1 className="mt-2 flex items-center gap-2.5 font-serif text-3xl tracking-tight text-ink sm:text-[2.1rem]">
          <SubjectDot subject={subject} className="h-3 w-3" />
          {subject}
        </h1>
      </div>
      {actions && <div className="flex shrink-0 gap-2 print:hidden">{actions}</div>}
    </header>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton for the chooser.
// ---------------------------------------------------------------------------

function ChooserSkeleton() {
  return (
    <div className="space-y-7">
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-72" />
      </div>
      <Skeleton className="h-56 w-full rounded-2xl" />
    </div>
  );
}
