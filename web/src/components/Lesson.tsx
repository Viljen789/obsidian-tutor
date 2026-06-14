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
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Compass,
  Lightbulb,
  RotateCcw,
  Sparkles,
  Target,
  Wand2,
  XCircle,
} from "lucide-react";
import type {
  Concept,
  GradeResult,
  NextItem,
  Question,
} from "@tutor/shared";
import { api } from "../lib/api";
import {
  useConcept,
  useConcepts,
  useInvalidateMastery,
} from "../lib/firestore-hooks";
import { useStats } from "../lib/stats";
import { useExplanation, type UseExplanation } from "../lib/streamExplain";
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
import { buildAssetResolver } from "../lib/assets";
import { ReadAloud } from "./ReadAloud";
import { Backlinks } from "./Backlinks";
import { TutorChat } from "./TutorChat";

// ---------------------------------------------------------------------------
// Confidence calibration — the learner predicts how sure they are BEFORE
// submitting; afterwards we compare that prediction against the SM-2 quality
// (0..5) and offer one kind, honest line. Optional: skipping it is fine.
// ---------------------------------------------------------------------------

type Confidence = "guessing" | "fairly" | "confident";

const CONFIDENCE_OPTIONS: { id: Confidence; label: string }[] = [
  { id: "guessing", label: "Guessing" },
  { id: "fairly", label: "Fairly sure" },
  { id: "confident", label: "Confident" },
];

/**
 * A gentle one-liner comparing predicted confidence with the graded SM-2
 * quality. `quality >= 4` reads as "high" (Got it / Solid / Effortless), `<= 2`
 * as "low" (No recall / Barely / Shaky), the middle as a near-miss. Always
 * encouraging, never scolding. Returns `null` when no confidence was chosen.
 */
function calibrationNote(
  confidence: Confidence | null,
  quality: number,
): string | null {
  if (!confidence) return null;
  const high = quality >= 4;
  const low = quality <= 2;

  if (confidence === "confident") {
    if (high) return "Confident and spot on — that knowledge is earning its keep.";
    if (low) return "You felt sure, but this one's shaky — worth revisiting soon.";
    return "Close to what you expected. A little more polish and it's solid.";
  }
  if (confidence === "guessing") {
    if (high) return "A lucky one — worth a real review so it isn't down to chance.";
    if (low) return "You guessed, and it was indeed unsteady — honest read.";
    return "A guess that half-landed. You know more here than you'd credit.";
  }
  // "fairly"
  if (high) return "Fairly sure, and rightly so — your instincts were well-calibrated.";
  if (low) return "Less settled than it felt — give this one another pass.";
  return "Right about where you placed yourself. Nicely calibrated.";
}

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
  // Resolve `![[image]]` embeds to the concept's uploaded asset URLs (set at ingest).
  const resolveAsset = useMemo(
    () => buildAssetResolver(conceptQuery.data?.assets),
    [conceptQuery.data?.assets],
  );

  // Reading column: the AI's intuition-first explanation, or the learner's own
  // raw note. Defaults to the explanation; resets when the concept changes.
  const [reading, setReading] = useState<ReadingMode>("explanation");
  useEffect(() => setReading("explanation"), [conceptId]);

  // --- Explanation (streamed; falls back to the plain callable) ------------
  const explain = useExplanation(conceptId);

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
        explain={explain}
        onRetry={explain.refetch}
        reading={reading}
        onReadingChange={setReading}
        note={conceptQuery.data?.bodyMarkdown}
        resolveWiki={resolveWiki}
        resolveAsset={resolveAsset}
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
              title={title}
              tone={tone}
              query={questions}
              onRetry={() => void questions.refetch()}
              onGraded={() => invalidateMastery(conceptId)}
            />
          )}
        </div>
      )}

      {/* Ask-a-follow-up — a quiet aside, available once the lesson is readable. */}
      {explain.isSuccess && (
        <div className="animate-fade">
          <TutorChat conceptId={conceptId} tone={tone} />
        </div>
      )}

      {/* "Linked from" / "Unlocks" — the vault's connective tissue. */}
      <Backlinks conceptId={conceptId} tone={tone} />
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
  explain,
  onRetry,
  reading,
  onReadingChange,
  note,
  resolveWiki,
  resolveAsset,
}: {
  tone: Tone;
  title: string;
  subject?: string;
  explain: UseExplanation;
  onRetry: () => void;
  reading: ReadingMode;
  onReadingChange: (mode: ReadingMode) => void;
  note?: string;
  resolveWiki: (target: string) => string | null;
  resolveAsset: (name: string) => string | null;
}) {
  // The "Your note" tab is only meaningful when the concept has a raw body.
  const hasNote = !!note && note.trim().length > 0;
  const showNote = reading === "note" && hasNote;
  // What the "Listen" control reads aloud: whichever markdown is on screen.
  const readText = showNote ? note ?? "" : explain.text;

  return (
    <article>
      <header className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <Eyebrow tone={tone}>{subject ?? "Lesson"}</Eyebrow>
          {!showNote && explain.data?.depth && (
            <Pill tone={tone} className="capitalize">
              {explain.data.depth}
            </Pill>
          )}
          {!showNote && explain.data?.cached && (
            <span className="text-[0.7rem] text-muted">from cache</span>
          )}
          {readText.trim().length > 0 && (
            <div className="ml-auto">
              <ReadAloud text={readText} tone={tone} />
            </div>
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
          <Markdown resolveWiki={resolveWiki} resolveAsset={resolveAsset}>{note!}</Markdown>
        </div>
      )}

      {/* Explanation — the AI's intuition-first lesson. */}
      {!showNote && (
        <>
          {explain.isPending && (
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

          {explain.isError && (
            <Card>
              <ErrorState
                title="The explanation didn't arrive"
                description="The tutor couldn't write this lesson just now. Give it another moment."
                onRetry={onRetry}
              />
            </Card>
          )}

          {explain.text.length > 0 && (
            <Markdown resolveWiki={resolveWiki} resolveAsset={resolveAsset}>{explain.text}</Markdown>
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
  title,
  tone,
  query,
  onRetry,
  onGraded,
}: {
  conceptId: string;
  title: string;
  tone: Tone;
  query: ReturnType<typeof useQuery<{ questions: Question[] }>>;
  onRetry: () => void;
  onGraded: () => void;
}) {
  const [index, setIndex] = useState(0);
  // Per-question SM-2 quality, lifted up from each QuestionCard as it grades.
  // Keyed by questionId so it survives any re-render without index drift.
  const [qualities, setQualities] = useState<Record<string, number>>({});
  const questions = query.data?.questions ?? [];
  const current = questions[index];
  const allGraded =
    questions.length > 0 && questions.every((q) => q.id in qualities);

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
        onGraded={(quality) => {
          setQualities((prev) => ({ ...prev, [current.id]: quality }));
          onGraded();
        }}
        onNext={() => setIndex((i) => i + 1)}
      />

      {/* Recap appears once every question has a graded quality — the learner
          sees their final feedback above and a calm summary here. */}
      {allGraded && (
        <SessionRecap
          title={title}
          tone={tone}
          questions={questions}
          qualities={qualities}
        />
      )}
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
  onGraded: (quality: number) => void;
  onNext: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [hintError, setHintError] = useState(false);
  // Pre-submit prediction of how sure the learner feels. Optional — submitting
  // without a choice is fine; it just means no calibration note afterward.
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  const { recordActivity } = useStats();

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
    onSuccess: (res) => {
      // Lift the graded SM-2 quality up for the session recap.
      onGraded(res.grade.quality);
      // A graded answer counts as study activity — advance the daily streak.
      void recordActivity();
    },
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
            <ConfidenceSelector
              tone={tone}
              value={confidence}
              onChange={setConfidence}
              disabled={grade.isPending}
            />

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
        <Feedback
          grade={graded}
          tone={tone}
          isLast={isLast}
          confidence={confidence}
          onNext={onNext}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Confidence selector — a quiet pre-submit prediction. Three calm chips; the
// chosen one tints to the tone. Re-clicking clears it (the choice is optional).
// ---------------------------------------------------------------------------

function ConfidenceSelector({
  tone,
  value,
  onChange,
  disabled,
}: {
  tone: Tone;
  value: Confidence | null;
  onChange: (c: Confidence | null) => void;
  disabled?: boolean;
}) {
  const activeBg = tone === "review" ? "bg-review/10" : "bg-accent/10";
  const activeText = tone === "review" ? "text-review" : "text-accent";
  const activeBorder = tone === "review" ? "border-review/30" : "border-accent/30";

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted">How sure are you?</span>
      <div className="flex flex-wrap gap-1.5">
        {CONFIDENCE_OPTIONS.map((opt) => {
          const active = value === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              // Toggle: clicking the active chip clears the (optional) choice.
              onClick={() => onChange(active ? null : opt.id)}
              className={
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-60 " +
                (active
                  ? `${activeBg} ${activeText} ${activeBorder}`
                  : "border-border text-muted hover:text-ink")
              }
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Graded feedback panel.
// ---------------------------------------------------------------------------

function Feedback({
  grade,
  tone,
  isLast,
  confidence,
  onNext,
}: {
  grade: GradeResult;
  tone: Tone;
  isLast: boolean;
  confidence: Confidence | null;
  onNext: () => void;
}) {
  const calibration = calibrationNote(confidence, grade.quality);

  return (
    <div className="animate-rise border-t border-border bg-bg/40 p-5 sm:p-6">
      <div className="flex items-center justify-between">
        <Eyebrow tone={tone}>Feedback</Eyebrow>
        <QualityMeter quality={grade.quality} tone={tone} />
      </div>

      {/* Confidence calibration — a kind one-liner comparing how sure the
          learner felt against the graded quality. Only when they predicted. */}
      {calibration && (
        <p className="mt-3 flex items-start gap-2 text-sm leading-relaxed text-muted">
          <Target size={15} className="mt-0.5 shrink-0 text-muted/80" />
          <span>{calibration}</span>
        </p>
      )}

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
// Session recap — shown once every question in the set has been graded. A calm
// summary: per-question qualities, the weakest spot, and a gentle next step.
// ---------------------------------------------------------------------------

function SessionRecap({
  title,
  tone,
  questions,
  qualities,
}: {
  title: string;
  tone: Tone;
  questions: Question[];
  qualities: Record<string, number>;
}) {
  const navigate = useNavigate();

  // Per-question rows in ask-order, each with its graded quality.
  const rows = useMemo(
    () =>
      questions.map((q, i) => ({
        question: q,
        n: i + 1,
        quality: qualities[q.id] ?? 0,
      })),
    [questions, qualities],
  );

  const avg = rows.length
    ? rows.reduce((s, r) => s + r.quality, 0) / rows.length
    : 0;

  // The weakest answer points at what to shore up. Ties resolve to the earliest.
  const weakest = useMemo(
    () =>
      rows.length === 0
        ? null
        : rows.reduce((lo, r) => (r.quality < lo.quality ? r : lo)),
    [rows],
  );

  // "What's next" reuses the adaptive sequencer + routing the chooser uses.
  const next = useMutation({
    mutationFn: (): Promise<NextItem> => api.nextItem({}),
    onSuccess: (item) => {
      if (item.action === "review" && item.conceptId)
        navigate(`/review/${item.conceptId}`);
      else if (item.action === "learn" && item.conceptId)
        navigate(`/learn/${item.conceptId}`);
      // action "none" → nothing queued; stay put. The CTA copy stays gentle.
    },
  });

  // A warm summary line keyed to the average — never a grade, just a read.
  const summary =
    avg >= 4
      ? "A strong pass. This concept is settling in nicely."
      : avg >= 2.5
        ? "A solid start — a couple of spots are still firming up."
        : "Early days for this one. A review soon will pay off.";

  return (
    <Card className="animate-rise overflow-hidden">
      <div className="p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <Eyebrow tone={tone}>Session recap</Eyebrow>
          <Pill tone={tone}>
            <CheckCircle2 size={13} /> Lesson complete
          </Pill>
        </div>

        <h2 className="mt-2 font-serif text-2xl tracking-tight text-ink">{title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">{summary}</p>

        {/* Per-question qualities — reuse the dot meter, one row per question. */}
        <ul className="mt-5 space-y-2.5">
          {rows.map((r) => (
            <li
              key={r.question.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg/40 px-3.5 py-2.5"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="shrink-0 text-xs font-medium text-muted">
                  Q{r.n}
                </span>
                <Pill tone="neutral">{QUESTION_TYPE_LABEL[r.question.type]}</Pill>
                <span className="truncate text-sm text-ink">
                  {r.question.prompt}
                </span>
              </span>
              <span className="shrink-0">
                <QualityMeter quality={r.quality} tone={tone} />
              </span>
            </li>
          ))}
        </ul>

        {/* Weakest spot — a pointer, framed as where to put attention next. */}
        {weakest && rows.length > 1 && (
          <div className="mt-4 flex gap-2.5 rounded-xl border border-border bg-surface p-4">
            <Compass size={16} className="mt-0.5 shrink-0 text-review" />
            <div className="min-w-0">
              <Eyebrow tone={tone}>Worth another look</Eyebrow>
              <p className="mt-1 text-sm leading-relaxed text-ink">
                The {QUESTION_TYPE_LABEL[weakest.question.type].toLowerCase()}{" "}
                question was the shakiest — “{weakest.question.prompt}” A short
                review will turn it solid.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* What's next — the same adaptive CTA the chooser uses, plus a quiet
          drill link for shoring up weak spots directly. */}
      <div className="flex flex-col gap-3 border-t border-border bg-bg/40 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <Button
          tone={tone}
          icon={ArrowRight}
          loading={next.isPending}
          onClick={() => next.mutate()}
        >
          Continue to what's next
        </Button>
        <Link
          to="/drill"
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink"
        >
          <Wand2 size={14} />
          Drill your weak spots
        </Link>
      </div>
    </Card>
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
