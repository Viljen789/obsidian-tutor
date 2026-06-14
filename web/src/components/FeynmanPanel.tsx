/**
 * Feynman "explain it back" panel — teaching-to-learn.
 *
 * A quiet, collapsible aside in the Lesson: the learner explains the concept in
 * their OWN words, and the tutor critiques the explanation itself (not an answer
 * to a question) — what's right, what's missing/wrong, and a refined version to
 * study. Collapsed it's a single calm button; expanded it's a textarea + submit.
 *
 * Backend: api.critiqueExplanation({ conceptId, explanation }) -> { score 0..1,
 * feedback, whatWasRight[], whatWasMissing[], refinedExplanation, model }.
 *
 * Mirrors the Lesson's feedback motif (CheckCircle2 green "right" / XCircle
 * review "missing"). Respects `tone` so it sits naturally in Learn (accent) or
 * Review (review). Every state — collapsed, writing, loading, error, result —
 * is handled; it never blanks the panel.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  CheckCircle2,
  Lightbulb,
  RotateCcw,
  Sparkles,
  XCircle,
} from "lucide-react";
import type { CritiqueExplanationResponse } from "@tutor/shared";
import { api } from "../lib/api";
import {
  Button,
  Card,
  ErrorState,
  Eyebrow,
  Pill,
  ProgressBar,
  Spinner,
  type Tone,
} from "./ui";
import { Markdown } from "./Markdown";

/** Minimum characters before we let the learner submit (matches the backend). */
const MIN_LENGTH = 10;

export function FeynmanPanel({
  conceptId,
  tone = "accent",
}: {
  conceptId: string;
  tone?: Tone;
}) {
  const [open, setOpen] = useState(false);
  const [explanation, setExplanation] = useState("");

  const critique = useMutation({
    mutationFn: (): Promise<CritiqueExplanationResponse> =>
      api.critiqueExplanation({ conceptId, explanation: explanation.trim() }),
  });

  const result = critique.data;
  const isDone = critique.isSuccess && !!result;

  // Collapsed: a single quiet invitation. Teaching-to-learn, offered, never forced.
  if (!open) {
    return (
      <Card className="animate-rise">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-ink/[0.02] sm:px-6"
        >
          <span
            className={
              "grid h-9 w-9 shrink-0 place-items-center rounded-xl " +
              (tone === "review"
                ? "bg-review/10 text-review"
                : "bg-accent/10 text-accent")
            }
          >
            <Sparkles size={18} />
          </span>
          <span className="min-w-0">
            <span className="block font-serif text-[1.05rem] leading-tight text-ink">
              Explain it in your own words
            </span>
            <span className="mt-0.5 block text-sm text-muted">
              Teach the idea back — the surest way to find the gaps.
            </span>
          </span>
        </button>
      </Card>
    );
  }

  return (
    <Card className="animate-rise overflow-hidden">
      <div className="p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <Eyebrow tone={tone}>Explain it back</Eyebrow>
          {!isDone && (
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs text-muted transition-colors hover:text-ink"
            >
              Close
            </button>
          )}
        </div>

        {/* Writing state — textarea + submit. Hidden once a critique lands. */}
        {!isDone && (
          <>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">
              Explain this concept as if teaching someone who's never met it. I'll
              read what you wrote — not an answer to a question — and show you
              what's solid, what's missing, and a refined version to keep.
            </p>

            <textarea
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              disabled={critique.isPending}
              rows={6}
              placeholder="In my own words, this concept is…"
              className={
                "mt-4 w-full resize-y rounded-xl border border-border bg-bg/50 px-3.5 py-3 text-[0.95rem] leading-relaxed text-ink placeholder:text-muted/70 " +
                "transition focus:outline-none focus:ring-2 focus:ring-offset-0 disabled:opacity-70 " +
                (tone === "review" ? "focus:ring-review/30" : "focus:ring-accent/30")
              }
            />

            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <Button
                tone={tone}
                icon={Sparkles}
                onClick={() => critique.mutate()}
                loading={critique.isPending}
                disabled={explanation.trim().length < MIN_LENGTH}
              >
                Critique my explanation
              </Button>
              {explanation.trim().length > 0 &&
                explanation.trim().length < MIN_LENGTH && (
                  <span className="text-xs text-muted">
                    A little more to go on, first.
                  </span>
                )}
            </div>

            {critique.isPending && (
              <div className="mt-4">
                <Spinner label="Reading your explanation…" />
              </div>
            )}

            {critique.isError && (
              <div className="mt-4">
                <ErrorState
                  title="That didn't go through"
                  description="The tutor couldn't read your explanation just now. Your words are still here — try again in a moment."
                  onRetry={() => critique.mutate()}
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* Result — score, feedback, right/missing lists, and a refined version. */}
      {isDone && (
        <CritiqueResult
          result={result}
          tone={tone}
          onTryAgain={() => {
            critique.reset();
            setExplanation("");
          }}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The critique itself — shown after a successful submission.
// ---------------------------------------------------------------------------

function CritiqueResult({
  result,
  tone,
  onTryAgain,
}: {
  result: CritiqueExplanationResponse;
  tone: Tone;
  onTryAgain: () => void;
}) {
  const percent = Math.round(Math.max(0, Math.min(1, result.score)) * 100);

  return (
    <div className="animate-rise border-t border-border bg-bg/40 p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <Eyebrow tone={tone}>Your explanation</Eyebrow>
        <Pill tone={tone}>{percent}% there</Pill>
      </div>

      {/* Score as a simple progress bar — completeness/correctness, 0..1. */}
      <div className="mt-3">
        <ProgressBar value={result.score} tone={tone} />
      </div>

      {result.feedback && (
        <p className="mt-4 text-[0.95rem] leading-relaxed text-ink">
          {result.feedback}
        </p>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <CritiqueList
          icon={CheckCircle2}
          iconClass="text-emerald-600 dark:text-emerald-400"
          title="What you got right"
          items={result.whatWasRight}
          emptyText="Nothing landed cleanly yet — that's what this is for."
        />
        <CritiqueList
          icon={XCircle}
          iconClass="text-review"
          title="What was missing"
          items={result.whatWasMissing}
          emptyText="Nothing important was missing. Genuinely well explained."
        />
      </div>

      {/* The refined explanation — a tight, correct version to study. Rendered as
          markdown (no wikilink resolution here; it's freshly generated prose). */}
      {result.refinedExplanation && (
        <div className="mt-5 rounded-xl border border-border bg-surface p-4 sm:p-5">
          <div className="flex items-center gap-2">
            <Lightbulb
              size={15}
              className={tone === "review" ? "text-review" : "text-accent"}
            />
            <Eyebrow tone={tone}>A refined version to keep</Eyebrow>
          </div>
          <div className="mt-2">
            <Markdown>{result.refinedExplanation}</Markdown>
          </div>
        </div>
      )}

      <div className="mt-5 flex items-center gap-2">
        <Button variant="secondary" tone="neutral" icon={RotateCcw} onClick={onTryAgain}>
          Try again
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A labelled list of critique points — same motif as the Lesson's feedback.
// ---------------------------------------------------------------------------

function CritiqueList({
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
