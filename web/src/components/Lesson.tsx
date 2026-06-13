/**
 * The teach -> Q&A -> grade -> update loop, shared by Learn and Review.
 *
 * Flow: explain the concept (markdown in the reading column) -> generate a small
 * mix of questions -> for each question the learner writes a free-text answer,
 * may request a hint (a nudge, surfaced BEFORE any answer is revealed), then
 * submits -> the backend grades and applies the SM-2 / mastery update atomically
 * -> we show partial-credit feedback and invalidate the mastery cache so the
 * learner's progress updates live.
 *
 * `tone` keeps Learn (accent / indigo) and Review (review / amber) visually
 * distinct while sharing one implementation. Every network step degrades
 * gracefully: explanation, questions, hint, and grading each have their own
 * loading / error handling and never blank the screen.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Lightbulb,
  RotateCcw,
  Sparkles,
  XCircle,
} from "lucide-react";
import type {
  Concept,
  ExplainConceptResponse,
  GradeResult,
  Question,
} from "@tutor/shared";
import { api } from "../lib/api";
import {
  useConcept,
  useConcepts,
  useInvalidateMastery,
} from "../lib/firestore-hooks";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Eyebrow,
  Pill,
  Skeleton,
  Spinner,
  type Tone,
} from "./ui";
import { Markdown } from "./Markdown";

const QUESTION_TYPE_LABEL: Record<Question["type"], string> = {
  recall: "Recall",
  application: "Apply",
  why: "Why",
};

/** Which markdown the reading column is showing. */
type ReadingMode = "explanation" | "note";

/** Normalise a wikilink target / title for case-insensitive matching. */
function normaliseKey(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Build a `[[wikilink]]` resolver from the user's concepts. A target resolves to
 * a conceptId by matching, case-insensitively, either the concept title or its
 * source filename (the basename of `sourcePath` without extension) — the two
 * spellings an Obsidian author naturally links by. Returns `null` for unknown
 * targets so the renderer can keep them as quiet text.
 */
function useWikiResolver(
  concepts: Concept[] | undefined,
): (target: string) => string | null {
  const index = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of concepts ?? []) {
      map.set(normaliseKey(c.title), c.id);
      // "Databases/Indexing.md" -> "indexing"
      const base = c.sourcePath
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "");
      if (base) map.set(normaliseKey(base), c.id);
    }
    return map;
  }, [concepts]);

  return useCallback(
    (target: string) => index.get(normaliseKey(target)) ?? null,
    [index],
  );
}

export function Lesson({
  conceptId,
  tone,
}: {
  conceptId: string;
  tone: Tone;
}) {
  const conceptQuery = useConcept(conceptId);
  const conceptsQuery = useConcepts();
  const invalidateMastery = useInvalidateMastery();
  const resolveWiki = useWikiResolver(conceptsQuery.data);

  // Reading column: the AI's intuition-first explanation, or the learner's own
  // raw note. Defaults to the explanation; resets when the concept changes.
  const [reading, setReading] = useState<ReadingMode>("explanation");
  useEffect(() => setReading("explanation"), [conceptId]);

  // --- Explanation ---------------------------------------------------------
  const explain = useQuery({
    queryKey: ["explain", conceptId],
    enabled: !!conceptId,
    retry: 0,
    queryFn: (): Promise<ExplainConceptResponse> =>
      api.explainConcept({ conceptId }),
  });

  // --- Questions (loaded on demand once the learner is ready) --------------
  const [started, setStarted] = useState(false);
  const questions = useQuery({
    queryKey: ["questions", conceptId],
    enabled: started,
    retry: 0,
    queryFn: () => api.generateQuestions({ conceptId, count: 3 }),
  });

  const title = conceptQuery.data?.title ?? "This concept";

  return (
    <div className="space-y-8">
      <ExplanationBlock
        tone={tone}
        title={title}
        subject={conceptQuery.data?.subject}
        query={explain}
        onRetry={() => void explain.refetch()}
        reading={reading}
        onReadingChange={setReading}
        note={conceptQuery.data?.bodyMarkdown}
        resolveWiki={resolveWiki}
      />

      {/* Q&A only appears once an explanation exists — you read, then practise. */}
      {explain.isSuccess && (
        <div className="animate-rise">
          {!started ? (
            <Card className="flex flex-col items-center gap-3 px-6 py-8 text-center">
              <Eyebrow tone={tone}>Check your understanding</Eyebrow>
              <p className="max-w-sm text-sm leading-relaxed text-muted">
                A few short questions — recall, application, and the “why.”
                Answer in your own words; partial credit counts.
              </p>
              <Button
                tone={tone}
                icon={Sparkles}
                className="mt-1"
                onClick={() => setStarted(true)}
              >
                Begin questions
              </Button>
            </Card>
          ) : (
            <QuestionFlow
              conceptId={conceptId}
              tone={tone}
              query={questions}
              onRetry={() => void questions.refetch()}
              onGraded={() => invalidateMastery(conceptId)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Explanation
// ---------------------------------------------------------------------------

function ExplanationBlock({
  tone,
  title,
  subject,
  query,
  onRetry,
  reading,
  onReadingChange,
  note,
  resolveWiki,
}: {
  tone: Tone;
  title: string;
  subject?: string;
  query: ReturnType<typeof useQuery<ExplainConceptResponse>>;
  onRetry: () => void;
  reading: ReadingMode;
  onReadingChange: (mode: ReadingMode) => void;
  note?: string;
  resolveWiki: (target: string) => string | null;
}) {
  // The "Your note" tab is only meaningful when the concept has a raw body.
  const hasNote = !!note && note.trim().length > 0;
  const showNote = reading === "note" && hasNote;

  return (
    <article>
      <header className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <Eyebrow tone={tone}>{subject ?? "Lesson"}</Eyebrow>
          {!showNote && query.data?.depth && (
            <Pill tone={tone} className="capitalize">
              {query.data.depth}
            </Pill>
          )}
          {!showNote && query.data?.cached && (
            <span className="text-[0.7rem] text-muted">from cache</span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <h1 className="font-serif text-3xl tracking-tight text-ink sm:text-[2.1rem]">
            {title}
          </h1>
          {hasNote && (
            <ReadingToggle
              tone={tone}
              value={reading}
              onChange={onReadingChange}
            />
          )}
        </div>
      </header>

      {/* Your note — the learner's raw vault markdown, rendered as-is. Independent
          of the explanation request, so it's readable even if that failed. */}
      {showNote && (
        <div className="animate-fade">
          <Markdown resolveWiki={resolveWiki}>{note!}</Markdown>
        </div>
      )}

      {/* Explanation — the AI's intuition-first lesson. */}
      {!showNote && (
        <>
          {query.isPending && (
            <div className="space-y-3 py-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-5/6" />
              <div className="pt-3" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-full" />
              <Spinner label="Composing your explanation…" />
            </div>
          )}

          {query.isError && (
            <Card>
              <ErrorState
                title="The explanation didn't arrive"
                description="The tutor couldn't write this lesson just now. Give it another moment."
                onRetry={onRetry}
              />
            </Card>
          )}

          {query.isSuccess && (
            <Markdown resolveWiki={resolveWiki}>{query.data.markdown}</Markdown>
          )}
        </>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Reading toggle — a subtle segmented control: Explanation vs Your note.
// ---------------------------------------------------------------------------

function ReadingToggle({
  tone,
  value,
  onChange,
}: {
  tone: Tone;
  value: ReadingMode;
  onChange: (mode: ReadingMode) => void;
}) {
  const options: { id: ReadingMode; label: string }[] = [
    { id: "explanation", label: "Explanation" },
    { id: "note", label: "Your note" },
  ];
  const activeBg = tone === "review" ? "bg-review/10" : "bg-accent/10";
  const activeText = tone === "review" ? "text-review" : "text-accent";

  return (
    <div
      role="tablist"
      aria-label="Reading source"
      className="mt-1 inline-flex shrink-0 rounded-full border border-border bg-surface p-0.5 text-xs font-medium"
    >
      {options.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.id)}
            className={
              "rounded-full px-3 py-1 transition-colors " +
              (active
                ? `${activeBg} ${activeText}`
                : "text-muted hover:text-ink")
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Question flow — one question at a time, with hint + grading.
// ---------------------------------------------------------------------------

function QuestionFlow({
  conceptId,
  tone,
  query,
  onRetry,
  onGraded,
}: {
  conceptId: string;
  tone: Tone;
  query: ReturnType<typeof useQuery<{ questions: Question[] }>>;
  onRetry: () => void;
  onGraded: () => void;
}) {
  const [index, setIndex] = useState(0);
  const questions = query.data?.questions ?? [];
  const current = questions[index];

  if (query.isPending) {
    return (
      <Card className="p-6">
        <div className="space-y-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-28 w-full" />
        </div>
        <div className="mt-4">
          <Spinner label="Writing a few good questions…" />
        </div>
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <ErrorState
          title="Couldn't generate questions"
          description="The question writer is unavailable right now. You can retry, or just keep reading."
          onRetry={onRetry}
        />
      </Card>
    );
  }

  if (!current) {
    return (
      <Card>
        <EmptyState
          icon={Sparkles}
          title="No questions for this one"
          description="There's nothing to practise here yet — revisit the reading above."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <Eyebrow tone={tone}>
          Question {index + 1} of {questions.length}
        </Eyebrow>
        <div className="flex gap-1.5" aria-hidden>
          {questions.map((q, i) => (
            <span
              key={q.id}
              className={
                "h-1.5 w-5 rounded-full transition-colors " +
                (i < index
                  ? tone === "review"
                    ? "bg-review"
                    : "bg-accent"
                  : i === index
                    ? tone === "review"
                      ? "bg-review/60"
                      : "bg-accent/60"
                    : "bg-ink/[0.1]")
              }
            />
          ))}
        </div>
      </div>

      <QuestionCard
        key={current.id}
        conceptId={conceptId}
        question={current}
        tone={tone}
        isLast={index === questions.length - 1}
        onGraded={onGraded}
        onNext={() => setIndex((i) => i + 1)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// A single question: answer -> (optional hint) -> submit -> feedback.
// ---------------------------------------------------------------------------

function QuestionCard({
  conceptId,
  question,
  tone,
  isLast,
  onGraded,
  onNext,
}: {
  conceptId: string;
  question: Question;
  tone: Tone;
  isLast: boolean;
  onGraded: () => void;
  onNext: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [hintError, setHintError] = useState(false);

  const hintMutation = useMutation({
    mutationFn: () =>
      api.requestHint({
        conceptId,
        question: question.prompt,
        partialAnswer: answer.trim() || undefined,
      }),
    onSuccess: (res) => {
      setHint(res.hint);
      setHintError(false);
    },
    onError: () => setHintError(true),
  });

  const grade = useMutation({
    mutationFn: (): Promise<{ grade: GradeResult }> =>
      api.submitAnswer({
        conceptId,
        questionId: question.id,
        question: question.prompt,
        answer: answer.trim(),
      }),
    onSuccess: () => onGraded(),
  });

  const graded = grade.data?.grade;
  const isGraded = grade.isSuccess && !!graded;

  return (
    <Card className="overflow-hidden">
      <div className="p-5 sm:p-6">
        <div className="mb-3 flex items-center gap-2">
          <Pill tone={tone}>{QUESTION_TYPE_LABEL[question.type]}</Pill>
        </div>
        <p className="font-serif text-lg leading-snug text-ink">{question.prompt}</p>

        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          disabled={isGraded || grade.isPending}
          rows={5}
          placeholder="Answer in your own words…"
          className={
            "mt-4 w-full resize-y rounded-xl border border-border bg-bg/50 px-3.5 py-3 text-[0.95rem] leading-relaxed text-ink placeholder:text-muted/70 " +
            "transition focus:outline-none focus:ring-2 focus:ring-offset-0 disabled:opacity-70 " +
            (tone === "review" ? "focus:ring-review/30" : "focus:ring-accent/30")
          }
        />

        {/* Hint lives BEFORE any answer is revealed — a nudge, never the solution. */}
        {!isGraded && (
          <>
            {hint && (
              <div className="animate-rise mt-3 flex gap-2.5 rounded-xl border border-border bg-bg/60 p-3.5">
                <Lightbulb size={16} className="mt-0.5 shrink-0 text-review" />
                <p className="text-sm leading-relaxed text-muted">{hint}</p>
              </div>
            )}
            {hintError && (
              <p className="mt-2 text-xs text-muted">
                Couldn't fetch a hint just now — try again, or take your best shot.
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <Button
                tone={tone}
                onClick={() => grade.mutate()}
                loading={grade.isPending}
                disabled={answer.trim().length === 0}
              >
                Submit answer
              </Button>
              <Button
                variant="secondary"
                tone="neutral"
                icon={Lightbulb}
                onClick={() => hintMutation.mutate()}
                loading={hintMutation.isPending}
              >
                {hint ? "Another hint" : "Get a hint"}
              </Button>
            </div>

            {grade.isError && (
              <p className="mt-3 text-sm text-muted">
                Grading didn't go through. Your answer is still here — try
                submitting again.
              </p>
            )}
          </>
        )}
      </div>

      {isGraded && (
        <Feedback grade={graded} tone={tone} isLast={isLast} onNext={onNext} />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Graded feedback panel.
// ---------------------------------------------------------------------------

function Feedback({
  grade,
  tone,
  isLast,
  onNext,
}: {
  grade: GradeResult;
  tone: Tone;
  isLast: boolean;
  onNext: () => void;
}) {
  return (
    <div className="animate-rise border-t border-border bg-bg/40 p-5 sm:p-6">
      <div className="flex items-center justify-between">
        <Eyebrow tone={tone}>Feedback</Eyebrow>
        <QualityMeter quality={grade.quality} tone={tone} />
      </div>

      {grade.feedback && (
        <p className="mt-3 text-[0.95rem] leading-relaxed text-ink">{grade.feedback}</p>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <FeedbackList
          icon={CheckCircle2}
          iconClass="text-emerald-600 dark:text-emerald-400"
          title="What you got right"
          items={grade.whatWasRight}
          emptyText="Nothing landed cleanly this time — that's okay."
        />
        <FeedbackList
          icon={XCircle}
          iconClass="text-review"
          title="What was missing"
          items={grade.whatWasMissing}
          emptyText="Nothing important was missing. Nicely done."
        />
      </div>

      {grade.correctedIntuition && (
        <div className="mt-4 rounded-xl border border-border bg-surface p-4">
          <Eyebrow tone={tone}>The intuition to keep</Eyebrow>
          <p className="mt-1.5 font-serif text-[1.05rem] leading-relaxed text-ink">
            {grade.correctedIntuition}
          </p>
        </div>
      )}

      <div className="mt-5 flex items-center gap-2">
        {isLast ? (
          <Pill tone={tone}>
            <CheckCircle2 size={13} /> Lesson complete
          </Pill>
        ) : (
          <Button tone={tone} icon={ArrowRight} onClick={onNext}>
            Next question
          </Button>
        )}
      </div>
    </div>
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
function QualityMeter({ quality, tone }: { quality: number; tone: Tone }) {
  const q = Math.max(0, Math.min(5, Math.round(quality)));
  const labels = ["No recall", "Barely", "Shaky", "Got it", "Solid", "Effortless"];
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-muted">{labels[q]}</span>
      <span className="flex gap-1" aria-label={`Quality ${q} of 5`}>
        {[0, 1, 2, 3, 4].map((i) =>
          i < q ? (
            <CheckCircle2
              key={i}
              size={14}
              className={tone === "review" ? "text-review" : "text-accent"}
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
// "Start over" affordance, exported for the route pages.
// ---------------------------------------------------------------------------

export function useLessonResetKey(conceptId: string | null) {
  // A changing key remounts <Lesson> for a fresh attempt without page reload.
  const [salt, setSalt] = useState(0);
  useEffect(() => setSalt(0), [conceptId]);
  const reset = () => setSalt((s) => s + 1);
  const key = useMemo(() => `${conceptId ?? "none"}:${salt}`, [conceptId, salt]);
  return { key, reset, Icon: RotateCcw };
}
