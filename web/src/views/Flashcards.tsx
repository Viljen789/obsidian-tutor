/**
 * Flashcards (/flashcards, /flashcards/:conceptId) — a fast recall drill.
 *
 * The drill is the SM-2 loop's lightest sibling. Instead of writing a free-text
 * answer and waiting on the grader (Learn/Review/Exam), the learner flips each
 * card and self-rates recall Anki-style: Again / Hard / Good / Easy → quality
 * 1 / 3 / 4 / 5. Each rating goes straight to api.reviewCard, which advances the
 * concept's mastery server-side (no model call), and we invalidate the mastery
 * cache so progress updates live — exactly as the Q&A loop does after grading.
 *
 * Two states behind one route:
 *   /flashcards               -> a chooser: concepts grouped by subject.
 *   /flashcards/:conceptId    -> the deck: one card at a time, reveal, rate,
 *                                advance; a calm summary on finish.
 *
 * It wears the app's reading-room vocabulary (ui.tsx primitives) and the accent
 * tone throughout. Card faces render through <Markdown> so cloze sentences with
 * math/code read correctly. Every network step has its own loading skeleton and
 * error state — the screen never blanks.
 */
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  Layers,
  Lightbulb,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import type { Concept, Flashcard, Mastery } from "@tutor/shared";
import { api } from "../lib/api";
import { useConcept, useConcepts, useInvalidateMastery } from "../lib/firestore-hooks";
import { useStats } from "../lib/stats";
import { dueLabel, pct, STATUS_LABEL } from "../lib/format";
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
import { Markdown } from "../components/Markdown";

const TONE = "accent" as const;

/** Anki-style self-rating → SM-2 quality. The drill's whole contract in one map. */
const RATINGS = [
  { label: "Again", quality: 1, hint: "No recall" },
  { label: "Hard", quality: 3, hint: "Shaky" },
  { label: "Good", quality: 4, hint: "Solid" },
  { label: "Easy", quality: 5, hint: "Effortless" },
] as const;

export function Flashcards() {
  const { conceptId } = useParams<{ conceptId?: string }>();
  if (conceptId) return <Drill conceptId={conceptId} />;
  return <ConceptChooser />;
}

// ---------------------------------------------------------------------------
// Chooser — shown at /flashcards with no concept selected.
// Concepts grouped by subject; click one to start its deck.
// ---------------------------------------------------------------------------

interface SubjectGroup {
  subject: string;
  concepts: Concept[];
}

function groupBySubject(concepts: Concept[]): SubjectGroup[] {
  const groups = new Map<string, Concept[]>();
  for (const c of concepts) {
    const list = groups.get(c.subject);
    if (list) list.push(c);
    else groups.set(c.subject, [c]);
  }
  return [...groups.entries()]
    .map(([subject, list]) => ({
      subject,
      concepts: list
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title)),
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

function ConceptChooser() {
  const navigate = useNavigate();
  const concepts = useConcepts();

  const groups = useMemo(
    () => groupBySubject(concepts.data ?? []),
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

  if (groups.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Layers}
          tone={TONE}
          title="No cards to drill yet"
          description="Import an Obsidian vault first — then you can drill recall on any concept in it."
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
        <Eyebrow tone={TONE}>Cards</Eyebrow>
        <h1 className="mt-1.5 font-serif text-[2rem] tracking-tight text-ink">
          Drill your recall
        </h1>
        <p className="mt-1 text-[0.95rem] text-muted">
          Pick a concept. We'll deal a small deck — flip each card, rate how well
          you knew it, and your mastery moves with every answer.
        </p>
      </header>

      {groups.map((group) => (
        <section key={group.subject}>
          <Eyebrow>
            <span className="inline-flex items-center gap-1.5">
              <SubjectDot subject={group.subject} />
              {group.subject}
            </span>
          </Eyebrow>
          <Card className="mt-3 divide-y divide-border overflow-hidden">
            {group.concepts.map((concept) => (
              <button
                key={concept.id}
                onClick={() => navigate(`/flashcards/${concept.id}`)}
                className="group flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors hover:bg-accent/[0.04]"
              >
                <p className="min-w-0 truncate text-[0.95rem] font-medium text-ink">
                  {concept.title}
                </p>
                <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted transition-colors group-hover:text-accent">
                  Drill
                  <ArrowRight size={15} />
                </span>
              </button>
            ))}
          </Card>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drill — the deck for one concept: generate, flip, rate, advance, summarise.
// ---------------------------------------------------------------------------

function Drill({ conceptId }: { conceptId: string }) {
  const navigate = useNavigate();
  const invalidateMastery = useInvalidateMastery();
  const { recordActivity } = useStats();
  const conceptQuery = useConcept(conceptId);

  // The deck (cached server-side; retry: 0 so a failure surfaces calmly).
  const deck = useQuery({
    queryKey: ["flashcards", conceptId],
    enabled: !!conceptId,
    retry: 0,
    queryFn: () => api.generateFlashcards({ conceptId }),
  });

  // Drill position + a running tally for the summary. Self-rating a card sends
  // its quality to the backend, then advances; reaching the end shows a summary.
  const [index, setIndex] = useState(0);
  const [reviewed, setReviewed] = useState(0);
  // Latest mastery returned by reviewCard, so the summary reflects live progress.
  const [latestMastery, setLatestMastery] = useState<Mastery | null>(null);

  const review = useMutation({
    mutationFn: (quality: number) => api.reviewCard({ conceptId, quality }),
    onSuccess: (res) => {
      setLatestMastery(res.mastery);
      // The concept moved on the SM-2 schedule — reflect it everywhere, live.
      invalidateMastery(conceptId);
      // A card review counts as study activity — advance the daily streak.
      void recordActivity();
    },
  });

  const cards = deck.data?.cards ?? [];
  const title = conceptQuery.data?.title ?? "This concept";

  const restart = () => {
    setIndex(0);
    setReviewed(0);
    setLatestMastery(null);
    review.reset();
    void deck.refetch();
  };

  const back = (
    <button
      onClick={() => navigate("/flashcards")}
      className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink"
    >
      <ArrowLeft size={15} /> Cards
    </button>
  );

  // --- Generating the deck -------------------------------------------------
  if (deck.isPending) {
    return (
      <div className="animate-fade">
        <div className="mb-6">{back}</div>
        <DeckHeader title={title} subject={conceptQuery.data?.subject} />
        <Card className="mt-6 p-6">
          <div className="space-y-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-28 w-full" />
          </div>
          <div className="mt-4">
            <Spinner label="Dealing your deck…" />
          </div>
        </Card>
      </div>
    );
  }

  if (deck.isError) {
    return (
      <div className="animate-fade">
        <div className="mb-6">{back}</div>
        <DeckHeader title={title} subject={conceptQuery.data?.subject} />
        <Card className="mt-6">
          <ErrorState
            title="Couldn't deal the deck"
            description="The card writer is unavailable just now. Give it another moment, or pick a different concept."
            onRetry={() => void deck.refetch()}
          />
        </Card>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="animate-fade">
        <div className="mb-6">{back}</div>
        <DeckHeader title={title} subject={conceptQuery.data?.subject} />
        <Card className="mt-6">
          <EmptyState
            icon={Layers}
            tone={TONE}
            title="No cards for this one"
            description="We couldn't build a deck for this concept. Try again, or choose another."
            action={
              <Button tone={TONE} onClick={() => void deck.refetch()}>
                Try again
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  // --- Finished — a calm summary ------------------------------------------
  // `current` is undefined once we've drilled past the last card (index ===
  // cards.length): that's the finish line, so we show the summary.
  const current = cards[index];
  if (!current) {
    return (
      <DrillSummary
        title={title}
        subject={conceptQuery.data?.subject}
        reviewed={reviewed}
        total={cards.length}
        mastery={latestMastery}
        onAgain={restart}
        onBack={() => navigate("/flashcards")}
        back={back}
      />
    );
  }

  return (
    <div className="animate-fade">
      <div className="mb-6">{back}</div>
      <DeckHeader title={title} subject={conceptQuery.data?.subject} />

      <div className="mt-6 space-y-3">
        <div className="flex items-center justify-between px-1">
          <Eyebrow tone={TONE}>
            Card {index + 1} of {cards.length}
          </Eyebrow>
          <div className="flex gap-1.5" aria-hidden>
            {cards.map((c, i) => (
              <span
                key={c.id}
                className={
                  "h-1.5 w-5 rounded-full transition-colors " +
                  (i < index
                    ? "bg-accent"
                    : i === index
                      ? "bg-accent/60"
                      : "bg-ink/[0.1]")
                }
              />
            ))}
          </div>
        </div>

        {/* Remount per card so reveal state resets cleanly between cards. */}
        <FlashcardItem
          key={current.id}
          card={current}
          rating={review}
          onRate={(quality) => {
            review.mutate(quality);
            setReviewed((n) => n + 1);
            setIndex((i) => i + 1);
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deck header — the concept's masthead, echoing the exam's "question paper".
// ---------------------------------------------------------------------------

function DeckHeader({ title, subject }: { title: string; subject?: string }) {
  return (
    <header className="border-b border-border pb-5">
      <Eyebrow tone={TONE}>{subject ?? "Flashcards"}</Eyebrow>
      <h1 className="mt-2 font-serif text-3xl tracking-tight text-ink sm:text-[2.1rem]">
        {title}
      </h1>
    </header>
  );
}

// ---------------------------------------------------------------------------
// A single flashcard: front -> reveal -> back (+ hint) -> self-rate.
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<Flashcard["kind"], string> = {
  cloze: "Fill in the blank",
  qa: "Question",
};

function FlashcardItem({
  card,
  rating,
  onRate,
}: {
  card: Flashcard;
  rating: ReturnType<typeof useMutation<{ mastery: Mastery }, Error, number>>;
  onRate: (quality: number) => void;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <Card className="overflow-hidden">
      <div className="p-5 sm:p-6">
        <div className="mb-3 flex items-center gap-2">
          <Pill tone={TONE}>{KIND_LABEL[card.kind]}</Pill>
        </div>

        {/* Front — the prompt. Markdown so cloze math/code renders correctly. */}
        <div className="font-serif text-lg leading-snug text-ink">
          <Markdown>{card.front}</Markdown>
        </div>

        {!revealed ? (
          <div className="mt-5">
            <Button tone={TONE} icon={Eye} onClick={() => setRevealed(true)}>
              Reveal answer
            </Button>
            {card.hint && (
              <p className="mt-3 text-xs text-muted">
                Stuck? Reveal to see the answer and a nudge.
              </p>
            )}
          </div>
        ) : (
          <div className="animate-rise">
            {/* Back — the answer. */}
            <div className="mt-5 rounded-xl border border-border bg-bg/50 p-4">
              <Eyebrow tone={TONE}>Answer</Eyebrow>
              <div className="mt-1.5 text-[0.97rem] leading-relaxed text-ink">
                <Markdown>{card.back}</Markdown>
              </div>
            </div>

            {/* Optional nudge, shown alongside the revealed answer. */}
            {card.hint && (
              <div className="mt-3 flex gap-2.5 rounded-xl border border-border bg-bg/60 p-3.5">
                <Lightbulb size={16} className="mt-0.5 shrink-0 text-review" />
                <p className="text-sm leading-relaxed text-muted">{card.hint}</p>
              </div>
            )}

            {/* Self-rating — Anki-style recall, mapped to SM-2 quality. */}
            <div className="mt-5">
              <Eyebrow>How well did you know it?</Eyebrow>
              <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {RATINGS.map((r) => (
                  <button
                    key={r.label}
                    onClick={() => onRate(r.quality)}
                    disabled={rating.isPending}
                    className="flex flex-col items-center gap-0.5 rounded-xl border border-border bg-surface px-3 py-2.5 text-center transition-colors hover:border-accent/40 hover:bg-accent/[0.05] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="text-sm font-medium text-ink">{r.label}</span>
                    <span className="text-[0.7rem] text-muted">{r.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Summary — a calm close: cards reviewed, live mastery, drill again / back.
// ---------------------------------------------------------------------------

function DrillSummary({
  title,
  subject,
  reviewed,
  total,
  mastery,
  onAgain,
  onBack,
  back,
}: {
  title: string;
  subject?: string;
  reviewed: number;
  total: number;
  mastery: Mastery | null;
  onAgain: () => void;
  onBack: () => void;
  back: React.ReactNode;
}) {
  return (
    <div className="animate-fade">
      <div className="mb-6">{back}</div>
      <DeckHeader title={title} subject={subject} />

      <Card className="mt-6 flex flex-col items-center gap-3 px-6 py-10 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-accent/10 text-accent">
          <Sparkles size={22} />
        </div>
        <h2 className="font-serif text-xl text-ink">Deck complete</h2>
        <p className="max-w-md text-sm leading-relaxed text-muted">
          You drilled {reviewed} {reviewed === 1 ? "card" : "cards"} on {title}.
          Each rating nudged your spacing schedule — come back when these start to
          fade.
        </p>

        {/* Live mastery, straight from the last reviewCard response. */}
        {mastery && (
          <div className="mt-2 w-full max-w-xs">
            <div className="flex items-center justify-between text-xs text-muted">
              <span className="inline-flex items-center gap-1.5">
                <Pill tone={TONE}>{STATUS_LABEL[mastery.status]}</Pill>
              </span>
              <span>{pct(mastery.masteryScore)}% mastery</span>
            </div>
            <ProgressBar
              value={mastery.masteryScore}
              tone={TONE}
              className="mt-2"
            />
            <p className="mt-2 text-xs text-muted">{dueLabel(mastery.dueDate)}</p>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button tone={TONE} icon={RotateCcw} onClick={onAgain}>
            Drill again
          </Button>
          <Button variant="secondary" tone="neutral" onClick={onBack}>
            Choose another
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted">
          {total} {total === 1 ? "card" : "cards"} in this deck
        </p>
      </Card>
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
      <Skeleton className="h-40 w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-2xl" />
    </div>
  );
}
