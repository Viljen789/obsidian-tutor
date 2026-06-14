/**
 * Mock mode (/mock) — sit a fresh exam written in the style of a past paper.
 *
 * The learner picks a subject, pastes the questions from a real past exam, and
 * the backend (api.generateMock) writes a NEW set of questions in the same
 * style and difficulty across that subject's concepts — never copying the
 * originals. The learner then sits them on one numbered answer sheet and
 * submits. Each answer is graded through the SAME grader as Learn/Review/Exam
 * (api.submitAnswer), so the mock doubles as a review and advances SM-2
 * mastery. Finally a marked report shows an overall score, per-question
 * feedback, and links to revisit the weakest concepts.
 *
 * This is a leaner sibling of Exam.tsx — it reuses the same primitives and
 * "question paper" framing, but swaps Exam's intro gate for a setup form
 * (subject + paste-a-past-paper) and Exam's generateExam for generateMock.
 * Every stage degrades gracefully: no subjects, generation failure, partial
 * grading failures, and an empty paper are all handled.
 */
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  FileText,
  GraduationCap,
  RotateCcw,
  Sparkles,
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
import { saveExamRecord } from "../lib/examHistory";
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

/** How many questions a mock aims for. The backend clamps and spreads these. */
const MOCK_COUNT = 10;

type Phase = "setup" | "sitting" | "results";

/** What the setup form hands to the generator once the learner commits. */
interface MockBrief {
  subject: string;
  pastExamText: string;
}

export function Mock() {
  const navigate = useNavigate();
  const invalidateMastery = useInvalidateMastery();
  const { recordActivity } = useStats();
  const { user } = useAuth();

  const concepts = useConcepts();
  const subjects = useMemo(
    () => summariseSubjects(concepts.data ?? []),
    [concepts.data],
  );

  // conceptId -> title, for the per-question labels + results "revisit" links.
  const titleFor = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of concepts.data ?? []) map.set(c.id, c.title);
    return (id: string) => map.get(id) ?? "this concept";
  }, [concepts.data]);

  const [phase, setPhase] = useState<Phase>("setup");
  // The brief the learner committed to; null until "Generate mock" is pressed.
  const [brief, setBrief] = useState<MockBrief | null>(null);
  // Epoch ms the learner began sitting — a ref so the timer never re-renders
  // the answer sheet. (We keep the sheet snappy; no live timer pill here.)
  const startedAtRef = useRef<number | null>(null);

  // --- Generate the paper (once a brief is committed) ----------------------
  const paper = useQuery({
    queryKey: ["mock", brief?.subject, brief?.pastExamText],
    enabled: phase !== "setup" && !!brief,
    retry: 0,
    queryFn: () =>
      api.generateMock({
        subject: brief!.subject,
        pastExamText: brief!.pastExamText,
        count: MOCK_COUNT,
      }),
  });

  // --- Answers (questionId -> text), local until submitted -----------------
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const setAnswer = (id: string, value: string) =>
    setAnswers((prev) => ({ ...prev, [id]: value }));

  const questions = paper.data?.questions ?? [];
  const answeredCount = questions.filter(
    (q) => (answers[q.id] ?? "").trim().length > 0,
  ).length;

  // --- Marking: grade every answer, then surface the report ----------------
  const mark = useMutation({
    mutationFn: async (): Promise<MarkedQuestion[]> => {
      return Promise.all(
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
    },
    onSuccess: (marked) => {
      const startedAt = startedAtRef.current;
      const durationSec =
        startedAt != null
          ? Math.max(0, Math.round((Date.now() - startedAt) / 1000))
          : null;
      startedAtRef.current = null;

      // Persist this sat mock as an ExamRecord — best-effort, labelled "(mock)"
      // so it reads distinctly from real exam papers in history.
      if (user?.uid && brief)
        void persistMockRecord(user.uid, brief.subject, marked, durationSec);

      // Many concepts moved — refresh the whole mastery cache once.
      invalidateMastery();
      // Sitting a mock counts as study activity — advance the daily streak.
      void recordActivity();
      setPhase("results");
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
  });

  const startOver = () => {
    setAnswers({});
    mark.reset();
    startedAtRef.current = null;
    setBrief(null);
    setPhase("setup");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // --- Setup: subject + paste-a-past-paper ---------------------------------
  if (phase === "setup") {
    if (concepts.isPending) return <SetupSkeleton />;

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
            title="No subjects to mock yet"
            description="Import an Obsidian vault first — then you can paste a past paper and sit a fresh mock on any subject in it."
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
      <SetupForm
        subjects={subjects}
        onGenerate={(b) => {
          startedAtRef.current = Date.now();
          setBrief(b);
          setPhase("sitting");
        }}
      />
    );
  }

  const subject = brief?.subject ?? "";

  const back = (
    <button
      onClick={startOver}
      className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink"
    >
      <ArrowLeft size={15} /> New mock
    </button>
  );

  // Generating the paper.
  if (paper.isPending) {
    return (
      <div className="animate-fade">
        <div className="mb-6">{back}</div>
        <MockHeader subject={subject} />
        <Card className="mt-6 space-y-4 p-6">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-24 w-full" />
          <Spinner label="Writing a fresh paper in the same style…" />
        </Card>
      </div>
    );
  }

  if (paper.isError) {
    return (
      <div className="animate-fade">
        <div className="mb-6">{back}</div>
        <MockHeader subject={subject} />
        <Card className="mt-6">
          <ErrorState
            title="Couldn't write the mock"
            description="The exam writer is unavailable just now. Give it another moment, or tweak the questions you pasted."
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
        <MockHeader subject={subject} />
        <Card className="mt-6">
          <EmptyState
            icon={FileText}
            tone={TONE}
            title="No questions came back"
            description="We couldn't write a mock from that paste. Try again, or paste a clearer set of past-exam questions."
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
        onNewMock={startOver}
      />
    );
  }

  // Sitting the mock — the answer sheet.
  return (
    <div className="animate-fade pb-28">
      <div className="mb-6">{back}</div>
      <MockHeader subject={subject} count={questions.length} />

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

      {/* Sticky submit bar — progress + the one action that ends the mock. */}
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
            {mark.isPending ? "Marking…" : "Submit mock"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup form — subject chooser + a large textarea to paste the past paper.
// ---------------------------------------------------------------------------

function SetupForm({
  subjects,
  onGenerate,
}: {
  subjects: SubjectSummary[];
  onGenerate: (brief: MockBrief) => void;
}) {
  const [subject, setSubject] = useState<string>(subjects[0]?.subject ?? "");
  const [pastExamText, setPastExamText] = useState("");

  const trimmed = pastExamText.trim();
  const canGenerate = subject.length > 0 && trimmed.length > 0;

  return (
    <div className="animate-fade space-y-7">
      <header>
        <Eyebrow tone={TONE}>Mock exam</Eyebrow>
        <h1 className="mt-1.5 font-serif text-[2rem] tracking-tight text-ink">
          Sit a mock from a past paper
        </h1>
        <p className="mt-1 text-[0.95rem] text-muted">
          Paste a past exam's questions — we'll write a fresh paper in the same
          style across {subject || "your subject"}, then mark it.
        </p>
      </header>

      <section>
        <Eyebrow>Subject</Eyebrow>
        <Card className="mt-3 divide-y divide-border overflow-hidden">
          {subjects.map((s) => {
            const selected = s.subject === subject;
            return (
              <button
                key={s.subject}
                onClick={() => setSubject(s.subject)}
                aria-pressed={selected}
                className={
                  "group flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors " +
                  (selected ? "bg-accent/[0.06]" : "hover:bg-accent/[0.04]")
                }
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
                {selected && (
                  <CheckCircle2
                    size={18}
                    className="shrink-0 text-accent"
                    aria-hidden
                  />
                )}
              </button>
            );
          })}
        </Card>
      </section>

      <section>
        <Eyebrow>Paste the past paper</Eyebrow>
        <Card className="mt-3 p-5 sm:p-6">
          <label htmlFor="mock-past-paper" className="sr-only">
            Past exam questions
          </label>
          <textarea
            id="mock-past-paper"
            value={pastExamText}
            onChange={(e) => setPastExamText(e.target.value)}
            rows={12}
            placeholder={
              "Paste the questions from a past exam here.\n\nWe won't copy them — we'll use them to gauge the style, difficulty, and coverage, then write you a fresh paper."
            }
            className={
              "w-full resize-y rounded-xl border border-border bg-bg/50 px-3.5 py-3 text-[0.95rem] leading-relaxed text-ink placeholder:text-muted/70 " +
              "transition focus:outline-none focus:ring-2 focus:ring-offset-0 focus:ring-accent/30"
            }
          />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted">
              We'll write around {MOCK_COUNT} fresh questions, never copying the
              originals.
            </p>
            <Button
              tone={TONE}
              icon={Sparkles}
              disabled={!canGenerate}
              onClick={() => onGenerate({ subject, pastExamText: trimmed })}
            >
              Generate mock
            </Button>
          </div>
        </Card>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mock header — the "question paper" masthead.
// ---------------------------------------------------------------------------

function MockHeader({ subject, count }: { subject: string; count?: number }) {
  return (
    <header className="border-b border-border pb-5">
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow tone={TONE}>Mock exam</Eyebrow>
        {count != null && <Pill tone={TONE}>{count} questions</Pill>}
      </div>
      <h1 className="mt-2 font-serif text-3xl tracking-tight text-ink sm:text-[2.1rem]">
        {subject}
      </h1>
    </header>
  );
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
            <p className="font-serif text-lg leading-snug text-ink">
              {question.prompt}
            </p>
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
 * Assemble a marked mock into an ExamRecord and persist it. Best-effort: any
 * failure (Firestore down, offline) is swallowed so it can never block the
 * results report. The subject is labelled "<subject> (mock)" so it reads
 * distinctly from real exam papers. The score mirrors ResultsReport exactly —
 * rounded total/maxQuality over the graded questions.
 */
async function persistMockRecord(
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
    const scorePercent =
      maxQuality > 0 ? Math.round((totalQuality / maxQuality) * 100) : 0;

    const results: ExamQuestionResult[] = marked.map((m) => ({
      conceptId: m.question.conceptId,
      type: m.question.type,
      prompt: m.question.prompt,
      quality: m.grade ? m.grade.quality : null,
    }));

    const record: ExamRecord = {
      id: crypto.randomUUID(),
      subject: `${subject} (mock)`,
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
  if (percent >= 90) return "Mock aced";
  if (percent >= 75) return "Strong paper";
  if (percent >= 55) return "A solid pass";
  if (percent >= 35) return "Some gaps to close";
  return "Worth another pass";
}

function ResultsReport({
  subject,
  marked,
  titleFor,
  onNewMock,
}: {
  subject: string;
  marked: MarkedQuestion[];
  titleFor: (conceptId: string) => string;
  onNewMock: () => void;
}) {
  const navigate = useNavigate();

  const graded = marked.filter(
    (m): m is MarkedQuestion & { grade: GradeResult } => !!m.grade,
  );
  const totalQuality = graded.reduce((sum, m) => sum + m.grade.quality, 0);
  const maxQuality = graded.length * 5;
  const percent =
    maxQuality > 0 ? Math.round((totalQuality / maxQuality) * 100) : 0;

  // Weakest concepts (quality <= 2), de-duplicated, for the "revisit" rail.
  const weak = useMemo(() => {
    const seen = new Set<string>();
    const out: { conceptId: string; title: string }[] = [];
    for (const m of graded) {
      if (m.grade.quality <= 2 && !seen.has(m.question.conceptId)) {
        seen.add(m.question.conceptId);
        out.push({
          conceptId: m.question.conceptId,
          title: titleFor(m.question.conceptId),
        });
      }
    }
    return out;
  }, [graded, titleFor]);

  const headline = scoreHeadline(percent);

  return (
    <div className="animate-fade space-y-7 pb-12">
      <header className="border-b border-border pb-5">
        <Eyebrow tone={TONE}>Results · {subject} (mock)</Eyebrow>
        <h1 className="mt-1.5 font-serif text-[2rem] tracking-tight text-ink">
          {headline}
        </h1>
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
            <Button
              variant="secondary"
              tone="neutral"
              icon={RotateCcw}
              onClick={onNewMock}
            >
              New mock
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
          <MarkedCard
            key={m.question.id}
            index={i}
            marked={m}
            onRevisit={() => navigate(`/learn/${m.question.conceptId}`)}
          />
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
              <p className="mt-2 font-serif text-lg leading-snug text-ink">
                {question.prompt}
              </p>
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
            {answer.trim() || (
              <span className="italic text-muted">Left blank</span>
            )}
          </p>
        </div>

        {!grade ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted">This answer couldn't be marked.</p>
            <Button
              variant="secondary"
              tone="neutral"
              size="sm"
              icon={GraduationCap}
              onClick={onRevisit}
            >
              Revisit concept
            </Button>
          </div>
        ) : (
          <>
            {grade.feedback && (
              <p className="mt-4 text-[0.95rem] leading-relaxed text-ink">
                {grade.feedback}
              </p>
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
              <Button
                variant="secondary"
                tone="neutral"
                size="sm"
                icon={GraduationCap}
                onClick={onRevisit}
              >
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
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
        {title}
      </h4>
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
// Subject summary helpers + loading skeleton.
// ---------------------------------------------------------------------------

interface SubjectSummary {
  subject: string;
  count: number;
}

function summariseSubjects(concepts: Concept[]): SubjectSummary[] {
  const counts = new Map<string, number>();
  for (const c of concepts)
    counts.set(c.subject, (counts.get(c.subject) ?? 0) + 1);
  return [...counts.entries()]
    .map(([subject, count]) => ({ subject, count }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

function SetupSkeleton() {
  return (
    <div className="space-y-7">
      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-72" />
      </div>
      <Skeleton className="h-40 w-full rounded-2xl" />
      <Skeleton className="h-64 w-full rounded-2xl" />
    </div>
  );
}
