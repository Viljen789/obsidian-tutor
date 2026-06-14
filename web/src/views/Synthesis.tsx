/**
 * Synthesis mode (/synthesis, /synthesis/:subject) — sit a set of cross-concept
 * "integration" questions that each weave two or more of a subject's concepts
 * together, the kind of exam question that spans topics.
 *
 * /synthesis           → a subject chooser (only subjects with >= 2 concepts).
 * /synthesis/:subject  → generate a set via api.generateSynthesis, then an answer
 *                        sheet (one textarea per question, with small pills naming
 *                        the concepts each question integrates). Submitting grades
 *                        every answer through api.gradeSynthesis (which advances
 *                        each involved concept's mastery), then shows a marked
 *                        report with per-question feedback.
 *
 * A leaner sibling of Mock.tsx: it reuses the same "question paper" framing and
 * the same grading/report primitives, but swaps Mock's paste-a-past-paper setup
 * for a one-click subject pick, and shows MULTIPLE concept pills per question
 * because a synthesis question is, by definition, multi-concept. Every stage
 * degrades gracefully: no eligible subjects, generation failure, partial grading
 * failures, and an empty set are all handled.
 */
import { useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Blocks,
  CheckCircle2,
  Circle,
  GraduationCap,
  Layers,
  RotateCcw,
  XCircle,
} from "lucide-react";
import type {
  Concept,
  GradeResult,
  QuestionType,
  SynthesisQuestion,
} from "@tutor/shared";
import { api } from "../lib/api";
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

const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  recall: "Connect",
  application: "Apply",
  why: "Why",
};

/** How many synthesis questions to ask for. The backend clamps/validates these. */
const SYNTHESIS_COUNT = 6;

export function Synthesis() {
  const navigate = useNavigate();
  const { subject: subjectParam } = useParams<{ subject?: string }>();
  const subject = subjectParam ? decodeURIComponent(subjectParam) : null;

  const invalidateMastery = useInvalidateMastery();
  const { recordActivity } = useStats();

  const concepts = useConcepts();
  // Only subjects with >= 2 concepts can support cross-concept synthesis.
  const subjects = useMemo(
    () => eligibleSubjects(concepts.data ?? []),
    [concepts.data],
  );

  // conceptId -> title, for the per-question concept pills + "revisit" links.
  const titleFor = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of concepts.data ?? []) map.set(c.id, c.title);
    return (id: string) => map.get(id) ?? "this concept";
  }, [concepts.data]);

  // --- Generate the question set (only when a subject is in the URL) --------
  const paper = useQuery({
    queryKey: ["synthesis", subject],
    enabled: !!subject,
    retry: 0,
    queryFn: () => api.generateSynthesis({ subject: subject!, count: SYNTHESIS_COUNT }),
  });

  // --- Answers (questionId -> text), local until submitted ------------------
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const setAnswer = (id: string, value: string) =>
    setAnswers((prev) => ({ ...prev, [id]: value }));

  const questions = paper.data?.questions ?? [];
  const answeredCount = questions.filter(
    (q) => (answers[q.id] ?? "").trim().length > 0,
  ).length;

  // Whether we've shown the marked report (kept local so "Start over" can reset).
  const [showResults, setShowResults] = useState(false);
  const startedAtRef = useRef<number | null>(null);

  // --- Marking: grade every answer, then surface the report ----------------
  const mark = useMutation({
    mutationFn: async (): Promise<MarkedQuestion[]> => {
      return Promise.all(
        questions.map(async (q): Promise<MarkedQuestion> => {
          const answer = (answers[q.id] ?? "").trim();
          try {
            const res = await api.gradeSynthesis({
              question: q.prompt,
              answer,
              conceptIds: q.conceptIds,
            });
            return { question: q, answer, grade: res.grade };
          } catch {
            // One failed grade shouldn't sink the whole report.
            return { question: q, answer, grade: null };
          }
        }),
      );
    },
    onSuccess: () => {
      // Many concepts moved — refresh the whole mastery cache once.
      invalidateMastery();
      // Sitting a synthesis set counts as study activity — advance the streak.
      void recordActivity();
      startedAtRef.current = null;
      setShowResults(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
  });

  const startOver = () => {
    setAnswers({});
    mark.reset();
    setShowResults(false);
    startedAtRef.current = null;
    void paper.refetch();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const chooseAnother = () => {
    navigate("/synthesis");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // --- Subject chooser (no subject in the URL) -----------------------------
  if (!subject) {
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
            icon={Layers}
            tone={TONE}
            title="No subjects to synthesise yet"
            description="Synthesis weaves two or more concepts together, so it needs a subject with at least two concepts. Import an Obsidian vault first."
            action={
              <Button tone={TONE} onClick={() => navigate("/import")}>
                Import a vault
              </Button>
            }
          />
        </Card>
      );
    }

    return <SubjectChooser subjects={subjects} onPick={(s) => navigate(`/synthesis/${encodeURIComponent(s)}`)} />;
  }

  const back = (
    <button
      onClick={chooseAnother}
      className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink"
    >
      <ArrowLeft size={15} /> Another subject
    </button>
  );

  // Generating the set.
  if (paper.isPending) {
    return (
      <div className="animate-fade">
        <div className="mb-6">{back}</div>
        <SynthesisHeader subject={subject} />
        <Card className="mt-6 space-y-4 p-6">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-24 w-full" />
          <Spinner label="Weaving your concepts into integration questions…" />
        </Card>
      </div>
    );
  }

  if (paper.isError) {
    return (
      <div className="animate-fade">
        <div className="mb-6">{back}</div>
        <SynthesisHeader subject={subject} />
        <Card className="mt-6">
          <ErrorState
            title="Couldn't write the synthesis set"
            description="The question writer is unavailable just now. Give it another moment and try again."
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
        <SynthesisHeader subject={subject} />
        <Card className="mt-6">
          <EmptyState
            icon={Blocks}
            tone={TONE}
            title="No questions came back"
            description="We couldn't weave a synthesis set for this subject just now. Try again in a moment."
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
  if (showResults && mark.data) {
    return (
      <ResultsReport
        subject={subject}
        marked={mark.data}
        titleFor={titleFor}
        onStartOver={startOver}
        onChooseAnother={chooseAnother}
      />
    );
  }

  // Sitting the set — the answer sheet.
  if (startedAtRef.current === null) startedAtRef.current = Date.now();

  return (
    <div className="animate-fade pb-28">
      <div className="mb-6">{back}</div>
      <SynthesisHeader subject={subject} count={questions.length} />

      <ol className="mt-6 space-y-4">
        {questions.map((q, i) => (
          <AnswerItem
            key={q.id}
            index={i}
            question={q}
            conceptTitles={q.conceptIds.map(titleFor)}
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

      {/* Sticky submit bar — progress + the one action that ends the set. */}
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
            {mark.isPending ? "Marking…" : "Submit answers"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subject chooser — pick a subject (with >= 2 concepts) to synthesise.
// ---------------------------------------------------------------------------

function SubjectChooser({
  subjects,
  onPick,
}: {
  subjects: SubjectSummary[];
  onPick: (subject: string) => void;
}) {
  return (
    <div className="animate-fade space-y-7">
      <header>
        <Eyebrow tone={TONE}>Synthesis</Eyebrow>
        <h1 className="mt-1.5 font-serif text-[2rem] tracking-tight text-ink">
          Connect concepts across a subject
        </h1>
        <p className="mt-1 text-[0.95rem] text-muted">
          Pick a subject and we'll write integration questions that each weave
          two or more of its concepts together — then mark how well you tie them.
        </p>
      </header>

      <section>
        <Eyebrow>Subject</Eyebrow>
        <Card className="mt-3 divide-y divide-border overflow-hidden">
          {subjects.map((s) => (
            <button
              key={s.subject}
              onClick={() => onPick(s.subject)}
              className="group flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors hover:bg-accent/[0.04]"
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 truncate text-[0.97rem] font-medium text-ink">
                  <SubjectDot subject={s.subject} />
                  {s.subject}
                </p>
                <p className="mt-0.5 pl-4 text-xs text-muted">
                  {s.count} concepts
                </p>
              </div>
              <Blocks size={18} className="shrink-0 text-muted/60 transition-colors group-hover:text-accent" aria-hidden />
            </button>
          ))}
        </Card>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Synthesis header — the "question paper" masthead.
// ---------------------------------------------------------------------------

function SynthesisHeader({ subject, count }: { subject: string; count?: number }) {
  return (
    <header className="border-b border-border pb-5">
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow tone={TONE}>Synthesis</Eyebrow>
        {count != null && <Pill tone={TONE}>{count} questions</Pill>}
      </div>
      <h1 className="mt-2 font-serif text-3xl tracking-tight text-ink sm:text-[2.1rem]">
        {subject}
      </h1>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Small concept pills — which concepts a question integrates.
// ---------------------------------------------------------------------------

function ConceptPills({ titles }: { titles: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {titles.map((t, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-full border border-accent/25 bg-accent/[0.06] px-2 py-0.5 text-xs text-accent"
        >
          <SubjectDot subject={t} />
          {t}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A single answer-sheet item: numbered prompt + concept pills + a textarea.
// ---------------------------------------------------------------------------

function AnswerItem({
  index,
  question,
  conceptTitles,
  value,
  disabled,
  onChange,
}: {
  index: number;
  question: SynthesisQuestion;
  conceptTitles: string[];
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
              <ConceptPills titles={conceptTitles} />
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
          rows={5}
          placeholder="Tie the concepts together in your own words…"
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
  question: SynthesisQuestion;
  answer: string;
  grade: GradeResult | null;
}

/** A warm, honest one-line verdict for the overall score. */
function scoreHeadline(percent: number): string {
  if (percent >= 90) return "Beautifully connected";
  if (percent >= 75) return "Strong synthesis";
  if (percent >= 55) return "Coming together";
  if (percent >= 35) return "Some threads to tie";
  return "Worth another weave";
}

function ResultsReport({
  subject,
  marked,
  titleFor,
  onStartOver,
  onChooseAnother,
}: {
  subject: string;
  marked: MarkedQuestion[];
  titleFor: (conceptId: string) => string;
  onStartOver: () => void;
  onChooseAnother: () => void;
}) {
  const navigate = useNavigate();

  const graded = marked.filter(
    (m): m is MarkedQuestion & { grade: GradeResult } => !!m.grade,
  );
  const totalQuality = graded.reduce((sum, m) => sum + m.grade.quality, 0);
  const maxQuality = graded.length * 5;
  const percent =
    maxQuality > 0 ? Math.round((totalQuality / maxQuality) * 100) : 0;

  // Weakest concepts (any question with quality <= 2 surfaces all its concepts),
  // de-duplicated, for the "revisit" rail.
  const weak = useMemo(() => {
    const seen = new Set<string>();
    const out: { conceptId: string; title: string }[] = [];
    for (const m of graded) {
      if (m.grade.quality > 2) continue;
      for (const id of m.question.conceptIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ conceptId: id, title: titleFor(id) });
      }
    }
    return out;
  }, [graded, titleFor]);

  const headline = scoreHeadline(percent);

  return (
    <div className="animate-fade space-y-7 pb-12">
      <header className="border-b border-border pb-5">
        <Eyebrow tone={TONE}>Results · {subject} synthesis</Eyebrow>
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
              icon={Layers}
              onClick={onChooseAnother}
            >
              Another subject
            </Button>
            <Button
              variant="secondary"
              tone="neutral"
              icon={RotateCcw}
              onClick={onStartOver}
            >
              New set
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
            These came up in answers that didn't quite connect. A focused lesson
            will shore them up.
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
            conceptTitles={m.question.conceptIds.map(titleFor)}
          />
        ))}
      </section>
    </div>
  );
}

function MarkedCard({
  index,
  marked,
  conceptTitles,
}: {
  index: number;
  marked: MarkedQuestion;
  conceptTitles: string[];
}) {
  const navigate = useNavigate();
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
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={TONE}>{QUESTION_TYPE_LABEL[question.type]}</Pill>
                <ConceptPills titles={conceptTitles} />
              </div>
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
            {answer.trim() || <span className="italic text-muted">Left blank</span>}
          </p>
        </div>

        {!grade ? (
          <p className="mt-4 text-sm text-muted">This answer couldn't be marked.</p>
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
                title="What you connected"
                items={grade.whatWasRight}
                emptyText="The connection didn't land cleanly here."
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

            {question.conceptIds.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {question.conceptIds.map((id, i) => (
                  <Button
                    key={id}
                    variant="secondary"
                    tone="neutral"
                    size="sm"
                    icon={GraduationCap}
                    onClick={() => navigate(`/learn/${id}`)}
                  >
                    Revisit {conceptTitles[i] ?? "concept"}
                  </Button>
                ))}
              </div>
            )}
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

/** Visualises the 0–5 quality as five quiet dots plus a label. */
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

/** Subjects with at least two concepts — the minimum for a synthesis question. */
function eligibleSubjects(concepts: Concept[]): SubjectSummary[] {
  const counts = new Map<string, number>();
  for (const c of concepts)
    counts.set(c.subject, (counts.get(c.subject) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([subject, count]) => ({ subject, count }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

function ChooserSkeleton() {
  return (
    <div className="space-y-7">
      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-72" />
      </div>
      <Skeleton className="h-56 w-full rounded-2xl" />
    </div>
  );
}
