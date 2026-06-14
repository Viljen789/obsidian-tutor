/**
 * Exam mode (/exam, /exam/:subject) — sit a practice exam across a whole subject.
 *
 * This is the teach -> grade loop's sibling: instead of one concept at a time,
 * the learner picks a subject, the backend (api.generateExam) writes a spread of
 * questions across that subject's concepts, and the learner answers them all on
 * one "answer sheet" before submitting. Each answer is then graded through the
 * SAME grader as Learn/Review (api.submitAnswer), so it also advances SM-2
 * mastery — an exam doubles as a big review session. Finally we show a marked
 * report: an overall score, per-question feedback, and links to revisit the
 * concepts that came out weakest.
 *
 * It shares the app's reading-room vocabulary (ui.tsx primitives) but wears its
 * own framing — a "question paper" header, a numbered answer sheet, and a marked
 * results report — so it feels like an exam, not another lesson. Accent tone
 * keeps it on-brand. Every stage degrades gracefully: no subjects, generation
 * failure, partial grading failures, and an empty paper are all handled.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Circle,
  Clock,
  FileText,
  GraduationCap,
  History,
  RotateCcw,
  XCircle,
} from "lucide-react";
import type {
  Concept,
  ExamQuestionResult,
  ExamRecord,
  GradeResult,
  Question,
} from "@tutor/shared";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { saveExamRecord, useExamHistory } from "../lib/examHistory";
import { shortDate } from "../lib/format";
import { useConcepts, useInvalidateMastery } from "../lib/firestore-hooks";
import { useStats } from "../lib/stats";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Eyebrow,
  Pill,
  ProgressBar,
  Skeleton,
  Spinner,
  SubjectDot,
} from "../components/ui";

const TONE = "accent" as const;

const QUESTION_TYPE_LABEL: Record<Question["type"], string> = {
  recall: "Recall",
  application: "Apply",
  why: "Why",
};

/** How many questions an exam aims for. The backend clamps and spreads these. */
const EXAM_COUNT = 10;

export function Exam() {
  const { subject } = useParams<{ subject?: string }>();
  if (subject) return <ExamRunner subject={decodeURIComponent(subject)} />;
  return <SubjectChooser />;
}

// ---------------------------------------------------------------------------
// Subject chooser — shown at /exam with no subject selected.
// ---------------------------------------------------------------------------

function SubjectChooser() {
  const navigate = useNavigate();
  const concepts = useConcepts();
  const history = useExamHistory();

  const subjects = useMemo(() => summariseSubjects(concepts.data ?? []), [concepts.data]);
  const pastPapers = history.data ?? [];

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
          icon={ClipboardCheck}
          tone={TONE}
          title="No subjects to examine yet"
          description="Import an Obsidian vault first — then you can sit a practice exam on any subject in it."
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
        <Eyebrow tone={TONE}>Exam</Eyebrow>
        <h1 className="mt-1.5 font-serif text-[2rem] tracking-tight text-ink">
          Sit a practice exam
        </h1>
        <p className="mt-1 text-[0.95rem] text-muted">
          Pick a subject. We'll set a spread of questions across its concepts —
          recall, application, and the “why” — then mark every answer and update
          your mastery as you go.
        </p>
      </header>

      <button
        onClick={() => navigate("/mock")}
        className="group flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-5 py-4 text-left transition-colors hover:bg-accent/[0.04]"
      >
        <span className="flex items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
            <FileText size={17} />
          </span>
          <span className="min-w-0">
            <span className="block text-[0.95rem] font-medium text-ink">Mock from a past paper</span>
            <span className="block text-xs text-muted">
              Paste an old exam — we'll write a fresh one in its style.
            </span>
          </span>
        </span>
        <ArrowRight
          size={16}
          className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5"
        />
      </button>

      <button
        onClick={() => navigate("/cheatsheet")}
        className="group flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-5 py-4 text-left transition-colors hover:bg-accent/[0.04]"
      >
        <span className="flex items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
            <FileText size={17} />
          </span>
          <span className="min-w-0">
            <span className="block text-[0.95rem] font-medium text-ink">Exam-day cheat sheet</span>
            <span className="block text-xs text-muted">
              Condense a subject into one printable page.
            </span>
          </span>
        </span>
        <ArrowRight
          size={16}
          className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5"
        />
      </button>

      <button
        onClick={() => navigate("/synthesis")}
        className="group flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-5 py-4 text-left transition-colors hover:bg-accent/[0.04]"
      >
        <span className="flex items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
            <GraduationCap size={17} />
          </span>
          <span className="min-w-0">
            <span className="block text-[0.95rem] font-medium text-ink">Synthesis questions</span>
            <span className="block text-xs text-muted">
              Integration questions that span several concepts.
            </span>
          </span>
        </span>
        <ArrowRight
          size={16}
          className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5"
        />
      </button>

      <section>
        <Eyebrow>Choose a subject</Eyebrow>
        <Card className="mt-3 divide-y divide-border overflow-hidden">
          {subjects.map((s) => (
            <button
              key={s.subject}
              onClick={() => navigate(`/exam/${encodeURIComponent(s.subject)}`)}
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
                Start
                <ArrowRight size={15} />
              </span>
            </button>
          ))}
        </Card>
      </section>

      {pastPapers.length > 0 && <PastPapers records={pastPapers} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Past papers — a calm history of previously sat exams. Each row re-takes that
// subject. Hidden by the caller when there's no history.
// ---------------------------------------------------------------------------

function PastPapers({ records }: { records: ExamRecord[] }) {
  const navigate = useNavigate();

  return (
    <section>
      <Eyebrow>
        <span className="inline-flex items-center gap-1.5">
          <History size={12} />
          Past papers
        </span>
      </Eyebrow>
      <Card className="mt-3 divide-y divide-border overflow-hidden">
        {records.map((r) => (
          <button
            key={r.id}
            onClick={() => navigate(`/exam/${encodeURIComponent(r.subject)}`)}
            className="group flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors hover:bg-accent/[0.04]"
          >
            <div className="min-w-0">
              <p className="flex items-center gap-2 truncate text-[0.95rem] font-medium text-ink">
                <SubjectDot subject={r.subject} />
                {r.subject}
              </p>
              <p className="mt-0.5 pl-4 text-xs text-muted">
                {shortDate(r.takenAt)}
                {r.durationSec != null && ` · ${formatDuration(r.durationSec)}`}
                {` · ${r.gradedCount}/${r.questionCount} marked`}
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-2">
              <Pill tone={TONE} className="tabular-nums">
                {r.scorePercent}%
              </Pill>
              <ArrowRight
                size={15}
                className="text-muted transition-colors group-hover:text-accent"
              />
            </span>
          </button>
        ))}
      </Card>
    </section>
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
// Exam runner — generates the paper, collects answers, then marks them.
// ---------------------------------------------------------------------------

type Phase = "intro" | "sitting" | "results";

function ExamRunner({ subject }: { subject: string }) {
  const navigate = useNavigate();
  const invalidateMastery = useInvalidateMastery();
  const { recordActivity } = useStats();
  const { user } = useAuth();

  const [phase, setPhase] = useState<Phase>("intro");
  // Epoch ms the learner began sitting, set the moment the answer sheet opens.
  // A ref (not state) so it never triggers a re-render of the answer sheet.
  const startedAtRef = useRef<number | null>(null);
  // conceptId titles for the results "revisit" links + nicer per-question labels.
  const concepts = useConcepts();
  const titleFor = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of concepts.data ?? []) map.set(c.id, c.title);
    return (id: string) => map.get(id) ?? "this concept";
  }, [concepts.data]);

  // --- Generate the paper (on demand, once the learner starts) -------------
  const paper = useQuery({
    queryKey: ["exam", subject],
    enabled: phase !== "intro",
    retry: 0,
    queryFn: () => api.generateExam({ subject, count: EXAM_COUNT }),
  });

  // --- Answers (questionId -> text), local until submitted ------------------
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const setAnswer = (id: string, value: string) =>
    setAnswers((prev) => ({ ...prev, [id]: value }));

  const questions = paper.data?.questions ?? [];
  const answeredCount = questions.filter((q) => (answers[q.id] ?? "").trim().length > 0).length;

  // --- Marking: grade every answer, then surface the report -----------------
  const mark = useMutation({
    mutationFn: async (): Promise<MarkedQuestion[]> => {
      const graded = await Promise.all(
        questions.map(async (q): Promise<MarkedQuestion> => {
          const answer = (answers[q.id] ?? "").trim();
          try {
            const res = await api.submitAnswer({
              conceptId: q.conceptId,
              questionId: q.id,
              question: q.prompt,
              answer,
            });
            return { question: q, answer, grade: res.grade };
          } catch {
            // One failed grade shouldn't sink the whole report.
            return { question: q, answer, grade: null };
          }
        }),
      );
      return graded;
    },
    onSuccess: (marked) => {
      // Capture wall-clock time the moment grading lands, then close the timer.
      const startedAt = startedAtRef.current;
      const durationSec =
        startedAt != null ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : null;
      startedAtRef.current = null;

      // Persist this sat exam as an ExamRecord — best-effort, never blocking the
      // report. Mirrors the score ResultsReport computes (round over graded).
      if (user?.uid) void persistExamRecord(user.uid, subject, marked, durationSec);

      // Many concepts moved — refresh the whole mastery cache once.
      invalidateMastery();
      // Sitting an exam counts as study activity — advance the daily streak.
      void recordActivity();
      setPhase("results");
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
  });

  const back = (
    <button
      onClick={() => navigate("/exam")}
      className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink"
    >
      <ArrowLeft size={15} /> Exam
    </button>
  );

  // Intro: a clear "you're about to sit an exam" gate.
  if (phase === "intro") {
    return (
      <div className="animate-fade">
        <div className="mb-6">{back}</div>
        <ExamHeader subject={subject} />
        <Card className="mt-6 flex flex-col items-center gap-3 px-6 py-9 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-accent/10 text-accent">
            <ClipboardCheck size={22} />
          </div>
          <h2 className="font-serif text-xl text-ink">Ready when you are</h2>
          <p className="max-w-md text-sm leading-relaxed text-muted">
            We'll set around {EXAM_COUNT} questions across {subject}. Answer them
            all in your own words, then submit to have the paper marked. Every
            answer also counts as a review, so your mastery updates as you go.
          </p>
          <Button
            tone={TONE}
            icon={ClipboardCheck}
            className="mt-1"
            onClick={() => {
              // Stamp the start the moment the learner commits to sitting.
              startedAtRef.current = Date.now();
              setPhase("sitting");
            }}
          >
            Start the exam
          </Button>
        </Card>
      </div>
    );
  }

  // Generating the paper.
  if (paper.isPending) {
    return (
      <div className="animate-fade">
        <div className="mb-6">{back}</div>
        <ExamHeader subject={subject} />
        <Card className="mt-6 space-y-4 p-6">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-24 w-full" />
          <Spinner label="Setting your question paper…" />
        </Card>
      </div>
    );
  }

  if (paper.isError) {
    return (
      <div className="animate-fade">
        <div className="mb-6">{back}</div>
        <ExamHeader subject={subject} />
        <Card className="mt-6">
          <ErrorState
            title="Couldn't set the paper"
            description="The exam writer is unavailable just now. Give it another moment, or pick a different subject."
            onRetry={() => void paper.refetch()}
          />
        </Card>
      </div>
    );
  }

  if (questions.length === 0) {
    return (
      <div className="animate-fade">
        <div className="mb-6">{back}</div>
        <ExamHeader subject={subject} />
        <Card className="mt-6">
          <EmptyState
            icon={FileText}
            tone={TONE}
            title="No questions came back"
            description="We couldn't build a paper for this subject. Try again, or choose another subject."
            action={
              <Button tone={TONE} onClick={() => void paper.refetch()}>
                Try again
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  // Results report.
  if (phase === "results" && mark.data) {
    return (
      <ResultsReport
        subject={subject}
        marked={mark.data}
        titleFor={titleFor}
        onRetake={() => {
          setAnswers({});
          mark.reset();
          startedAtRef.current = null;
          setPhase("intro");
          void paper.refetch();
        }}
      />
    );
  }

  // Sitting the exam — the answer sheet.
  return (
    <div className="animate-fade pb-28">
      <div className="mb-6">{back}</div>
      <ExamHeader
        subject={subject}
        count={questions.length}
        timer={<Timer startedAtRef={startedAtRef} running={!mark.isPending} />}
      />

      <ol className="mt-6 space-y-4">
        {questions.map((q, i) => (
          <AnswerItem
            key={q.id}
            index={i}
            question={q}
            conceptTitle={titleFor(q.conceptId)}
            value={answers[q.id] ?? ""}
            disabled={mark.isPending}
            onChange={(v) => setAnswer(q.id, v)}
          />
        ))}
      </ol>

      {mark.isError && (
        <p className="mt-4 text-sm text-muted">
          Marking didn't go through. Your answers are safe — try submitting again.
        </p>
      )}

      {/* Sticky submit bar — progress + the one action that ends the exam. */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-bg/85 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-4 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between text-xs text-muted">
              <span>
                {answeredCount} of {questions.length} answered
              </span>
            </div>
            <ProgressBar
              value={questions.length ? answeredCount / questions.length : 0}
              tone={TONE}
              className="mt-1.5"
            />
          </div>
          <Button
            tone={TONE}
            icon={CheckCircle2}
            loading={mark.isPending}
            disabled={answeredCount === 0}
            onClick={() => mark.mutate()}
            className="shrink-0"
          >
            {mark.isPending ? "Marking…" : "Submit exam"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exam header — the "question paper" masthead.
// ---------------------------------------------------------------------------

function ExamHeader({
  subject,
  count,
  timer,
}: {
  subject: string;
  count?: number;
  /** Live elapsed timer, shown only while the answer sheet is open. */
  timer?: React.ReactNode;
}) {
  return (
    <header className="border-b border-border pb-5">
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow tone={TONE}>Practice exam</Eyebrow>
        {count != null && <Pill tone={TONE}>{count} questions</Pill>}
        {timer}
      </div>
      <h1 className="mt-2 font-serif text-3xl tracking-tight text-ink sm:text-[2.1rem]">
        {subject}
      </h1>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Timer — a live mm:ss elapsed clock for the sitting phase.
//
// Holds its OWN tick state and reads the start time from a ref, so each second
// re-renders only this tiny node — never the answer sheet, so typing stays
// smooth. The interval is cleaned up on unmount and whenever `running` flips
// off (e.g. once the paper is submitted for marking).
// ---------------------------------------------------------------------------

function Timer({
  startedAtRef,
  running,
}: {
  startedAtRef: React.MutableRefObject<number | null>;
  running: boolean;
}) {
  const [, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const startedAt = startedAtRef.current;
  const elapsedSec = startedAt != null ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;

  return (
    <Pill tone="neutral">
      <Clock size={12} />
      <span className="tabular-nums" aria-label="Time elapsed">
        {formatDuration(elapsedSec)}
      </span>
    </Pill>
  );
}

/** Seconds → "m:ss" (or "h:mm:ss" past an hour). */
function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const mm = hours > 0 ? String(mins).padStart(2, "0") : String(mins);
  const ss = String(secs).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ---------------------------------------------------------------------------
// A single answer-sheet item: numbered prompt + a textarea.
// ---------------------------------------------------------------------------

function AnswerItem({
  index,
  question,
  conceptTitle,
  value,
  disabled,
  onChange,
}: {
  index: number;
  question: Question;
  conceptTitle: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Card as="li" className="overflow-hidden">
      <div className="p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/10 text-sm font-semibold text-accent">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Pill tone={TONE}>{QUESTION_TYPE_LABEL[question.type]}</Pill>
              <span className="inline-flex items-center gap-1 text-xs text-muted">
                <SubjectDot subject={conceptTitle} />
                {conceptTitle}
              </span>
            </div>
            <p className="font-serif text-lg leading-snug text-ink">{question.prompt}</p>
          </div>
        </div>

        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={4}
          placeholder="Answer in your own words…"
          className={
            "mt-4 w-full resize-y rounded-xl border border-border bg-bg/50 px-3.5 py-3 text-[0.95rem] leading-relaxed text-ink placeholder:text-muted/70 " +
            "transition focus:outline-none focus:ring-2 focus:ring-offset-0 focus:ring-accent/30 disabled:opacity-70"
          }
        />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Marked results report.
// ---------------------------------------------------------------------------

interface MarkedQuestion {
  question: Question;
  answer: string;
  grade: GradeResult | null;
}

/**
 * Assemble a marked paper into an ExamRecord and persist it. Best-effort: any
 * failure (Firestore down, offline) is swallowed so it can never block the
 * results report from rendering. The score mirrors ResultsReport exactly —
 * rounded total/maxQuality over the graded questions.
 */
async function persistExamRecord(
  uid: string,
  subject: string,
  marked: MarkedQuestion[],
  durationSec: number | null,
): Promise<void> {
  try {
    const graded = marked.filter(
      (m): m is MarkedQuestion & { grade: GradeResult } => !!m.grade,
    );
    const totalQuality = graded.reduce((sum, m) => sum + m.grade.quality, 0);
    const maxQuality = graded.length * 5;
    const scorePercent = maxQuality > 0 ? Math.round((totalQuality / maxQuality) * 100) : 0;

    const results: ExamQuestionResult[] = marked.map((m) => ({
      conceptId: m.question.conceptId,
      type: m.question.type,
      prompt: m.question.prompt,
      quality: m.grade ? m.grade.quality : null,
    }));

    const record: ExamRecord = {
      id: crypto.randomUUID(),
      subject,
      takenAt: new Date().toISOString(),
      durationSec,
      scorePercent,
      questionCount: marked.length,
      gradedCount: graded.length,
      results,
    };

    await saveExamRecord(uid, record);
  } catch {
    // Saving history is non-essential — never let it break showing results.
  }
}

/** A warm, honest one-line verdict for the overall score. */
function scoreHeadline(percent: number): string {
  if (percent >= 90) return "Exam aced";
  if (percent >= 75) return "Strong paper";
  if (percent >= 55) return "A solid pass";
  if (percent >= 35) return "Some gaps to close";
  return "Worth another pass";
}

function ResultsReport({
  subject,
  marked,
  titleFor,
  onRetake,
}: {
  subject: string;
  marked: MarkedQuestion[];
  titleFor: (conceptId: string) => string;
  onRetake: () => void;
}) {
  const navigate = useNavigate();

  const graded = marked.filter((m): m is MarkedQuestion & { grade: GradeResult } => !!m.grade);
  const totalQuality = graded.reduce((sum, m) => sum + m.grade.quality, 0);
  const maxQuality = graded.length * 5;
  const percent = maxQuality > 0 ? Math.round((totalQuality / maxQuality) * 100) : 0;

  // Weakest concepts (quality <= 2), de-duplicated, for the "revisit" rail.
  const weak = useMemo(() => {
    const seen = new Set<string>();
    const out: { conceptId: string; title: string }[] = [];
    for (const m of graded) {
      if (m.grade.quality <= 2 && !seen.has(m.question.conceptId)) {
        seen.add(m.question.conceptId);
        out.push({ conceptId: m.question.conceptId, title: titleFor(m.question.conceptId) });
      }
    }
    return out;
  }, [graded, titleFor]);

  const headline = scoreHeadline(percent);

  return (
    <div className="animate-fade space-y-7 pb-12">
      <header className="border-b border-border pb-5">
        <Eyebrow tone={TONE}>Results · {subject}</Eyebrow>
        <h1 className="mt-1.5 font-serif text-[2rem] tracking-tight text-ink">{headline}</h1>
      </header>

      {/* Score summary */}
      <Card className="p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-serif text-5xl tracking-tight text-ink">
              {percent}
              <span className="text-2xl text-muted">%</span>
            </p>
            <p className="mt-1 text-sm text-muted">
              {graded.length} of {marked.length} questions marked
              {graded.length < marked.length && " — some couldn't be graded"}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" tone="neutral" icon={RotateCcw} onClick={onRetake}>
              Retake
            </Button>
            <Button variant="secondary" tone="neutral" onClick={() => navigate("/exam")}>
              New subject
            </Button>
          </div>
        </div>
        <ProgressBar value={percent / 100} tone={TONE} className="mt-5" />
      </Card>

      {/* Revisit weak concepts */}
      {weak.length > 0 && (
        <section>
          <Eyebrow tone={TONE}>Worth revisiting</Eyebrow>
          <p className="mt-1 text-sm text-muted">
            These came out shakiest. A focused lesson will shore them up.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {weak.map((w) => (
              <button
                key={w.conceptId}
                onClick={() => navigate(`/learn/${w.conceptId}`)}
                className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/[0.06] px-3 py-1.5 text-sm text-accent transition-colors hover:bg-accent/[0.12]"
              >
                <GraduationCap size={14} />
                {w.title}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Per-question breakdown */}
      <section className="space-y-4">
        <Eyebrow>Question by question</Eyebrow>
        {marked.map((m, i) => (
          <MarkedCard key={m.question.id} index={i} marked={m} onRevisit={() => navigate(`/learn/${m.question.conceptId}`)} />
        ))}
      </section>
    </div>
  );
}

function MarkedCard({
  index,
  marked,
  onRevisit,
}: {
  index: number;
  marked: MarkedQuestion;
  onRevisit: () => void;
}) {
  const { question, answer, grade } = marked;

  return (
    <Card className="overflow-hidden">
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/10 text-sm font-semibold text-accent">
              {index + 1}
            </span>
            <div className="min-w-0">
              <Pill tone={TONE}>{QUESTION_TYPE_LABEL[question.type]}</Pill>
              <p className="mt-2 font-serif text-lg leading-snug text-ink">{question.prompt}</p>
            </div>
          </div>
          {grade && <QualityMeter quality={grade.quality} />}
        </div>

        {/* The learner's own answer, quoted back. */}
        <div className="mt-4 rounded-xl border border-border bg-bg/50 p-3.5">
          <h4 className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted">
            Your answer
          </h4>
          <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-ink">
            {answer.trim() || <span className="italic text-muted">Left blank</span>}
          </p>
        </div>

        {!grade ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted">This answer couldn't be marked.</p>
            <Button variant="secondary" tone="neutral" size="sm" icon={GraduationCap} onClick={onRevisit}>
              Revisit concept
            </Button>
          </div>
        ) : (
          <>
            {grade.feedback && (
              <p className="mt-4 text-[0.95rem] leading-relaxed text-ink">{grade.feedback}</p>
            )}

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <FeedbackList
                icon={CheckCircle2}
                iconClass="text-emerald-600 dark:text-emerald-400"
                title="What you got right"
                items={grade.whatWasRight}
                emptyText="Nothing landed cleanly here."
              />
              <FeedbackList
                icon={XCircle}
                iconClass="text-review"
                title="What was missing"
                items={grade.whatWasMissing}
                emptyText="Nothing important was missing."
              />
            </div>

            {grade.correctedIntuition && (
              <div className="mt-4 rounded-xl border border-border bg-surface p-4">
                <Eyebrow tone={TONE}>The intuition to keep</Eyebrow>
                <p className="mt-1.5 font-serif text-[1.05rem] leading-relaxed text-ink">
                  {grade.correctedIntuition}
                </p>
              </div>
            )}

            <div className="mt-4">
              <Button variant="secondary" tone="neutral" size="sm" icon={GraduationCap} onClick={onRevisit}>
                Revisit concept
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function FeedbackList({
  icon: Icon,
  iconClass,
  title,
  items,
  emptyText,
}: {
  icon: typeof CheckCircle2;
  iconClass: string;
  title: string;
  items: string[];
  emptyText: string;
}) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h4>
      {items.length === 0 ? (
        <p className="mt-2 text-sm italic text-muted">{emptyText}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {items.map((item, i) => (
            <li key={i} className="flex gap-2 text-sm leading-relaxed text-ink">
              <Icon size={15} className={"mt-0.5 shrink-0 " + iconClass} />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Visualises the 0–5 SM-2 quality as five quiet dots plus a label. */
function QualityMeter({ quality }: { quality: number }) {
  const q = Math.max(0, Math.min(5, Math.round(quality)));
  const labels = ["No recall", "Barely", "Shaky", "Got it", "Solid", "Effortless"];
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="text-xs font-medium text-muted">{labels[q]}</span>
      <span className="flex gap-1" aria-label={`Quality ${q} of 5`}>
        {[0, 1, 2, 3, 4].map((i) =>
          i < q ? (
            <CheckCircle2
              key={i}
              size={14}
              className="text-accent"
              fill="currentColor"
              fillOpacity={0.18}
            />
          ) : (
            <Circle key={i} size={14} className="text-ink/20" />
          ),
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton for the chooser.
// ---------------------------------------------------------------------------

function ChooserSkeleton() {
  return (
    <div className="space-y-7">
      <div className="space-y-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-8 w-64" />
      </div>
      <Skeleton className="h-56 w-full rounded-2xl" />
    </div>
  );
}
