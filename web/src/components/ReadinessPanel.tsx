/**
 * Exam-readiness gauge + countdown — a calm dashboard card that, per subject,
 * answers two questions: "how ready am I?" (a 0..100 score blended from mastery,
 * coverage, and review freshness) and "how long do I have?" (a countdown to a
 * self-set exam date). Subjects with an exam set float to the top, soonest
 * first; the rest sort weakest-readiness-first so the most urgent work leads.
 *
 * State sources: concepts + mastery (read-only, Cloud-Function-owned) and the
 * client-written exam-prefs doc. Setting a date writes through `useSetExamDate`,
 * which invalidates the prefs cache so the row re-sorts and re-renders live.
 */
import { useMemo } from "react";
import { CalendarClock, Gauge, X } from "lucide-react";
import { useConcepts, useMastery } from "../lib/firestore-hooks";
import { useExamPrefs, useSetExamDate } from "../lib/examPrefs";
import { daysUntil, subjectReadiness, type SubjectReadiness } from "../lib/readiness";
import { Card, Eyebrow, Pill, ProgressBar, Skeleton, SubjectDot, type Tone } from "./ui";

interface Row {
  subject: string;
  readiness: SubjectReadiness;
  /** ISO `yyyy-mm-dd` exam date, or null if none set. */
  examDate: string | null;
  /** Whole days until the exam; null when no (parseable) date. */
  days: number | null;
}

/** Tone for the gauge by readiness band — quiet review-red when weak, green when ready. */
function scoreTone(score: number): Tone {
  if (score >= 75) return "accent"; // styled emerald below via className
  if (score >= 40) return "accent";
  return "review";
}

/** A subtle emerald wash once a subject is genuinely exam-ready. */
function isStrong(score: number): boolean {
  return score >= 75;
}

/** Countdown phrasing from whole-day delta: "today!", "Exam passed", "9 days left". */
function countdownLabel(days: number): string {
  if (days === 0) return "Exam today!";
  if (days < 0) return "Exam passed";
  if (days === 1) return "1 day left";
  return `${days} days left`;
}

export function ReadinessPanel() {
  const concepts = useConcepts();
  const mastery = useMastery();
  const prefs = useExamPrefs();
  const setDate = useSetExamDate();

  const masteryMap = mastery.data ?? {};
  const examDates = prefs.data?.examDates ?? {};
  const conceptList = useMemo(() => concepts.data ?? [], [concepts.data]);

  // Distinct subjects present in the library, each scored and paired with its
  // exam date, then sorted: dated subjects first (soonest exam first), then the
  // rest by ascending readiness so the weakest — most urgent — leads.
  const rows = useMemo<Row[]>(() => {
    const subjects = [...new Set(conceptList.map((c) => c.subject))];
    const out: Row[] = subjects.map((subject) => {
      const readiness = subjectReadiness(conceptList, masteryMap, subject);
      const examDate = examDates[subject] ?? null;
      return { subject, readiness, examDate, days: examDate ? daysUntil(examDate) : null };
    });

    out.sort((a, b) => {
      const aDated = a.examDate != null;
      const bDated = b.examDate != null;
      if (aDated !== bDated) return aDated ? -1 : 1; // dated subjects first
      if (aDated && bDated) {
        // Both dated: soonest exam first. Unparseable dates sink to the bottom
        // of this group.
        const ad = a.days ?? Number.POSITIVE_INFINITY;
        const bd = b.days ?? Number.POSITIVE_INFINITY;
        if (ad !== bd) return ad - bd;
      }
      // Tie-break (and the undated group): weakest readiness first.
      return a.readiness.score - b.readiness.score;
    });
    return out;
  }, [conceptList, masteryMap, examDates]);

  // Loading the core signals — show a quiet skeleton rather than a flash of empty.
  if (concepts.isPending || mastery.isPending) {
    return (
      <Card className="p-5">
        <div className="mb-4 flex items-center gap-2">
          <Gauge size={15} className="text-muted" />
          <Eyebrow>Exam readiness</Eyebrow>
        </div>
        <div className="space-y-4">
          <Skeleton className="h-10 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      </Card>
    );
  }

  // No concepts → nothing to be ready for; render nothing (the Dashboard's own
  // empty state covers first-run).
  if (rows.length === 0) return null;

  return (
    <Card as="section" className="p-5">
      <div className="mb-1 flex items-center gap-2">
        <Gauge size={15} className="text-muted" />
        <Eyebrow>Exam readiness</Eyebrow>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-muted">
        A blend of how well you know each subject, how much you've covered, and
        how fresh your reviews are. Set an exam date to start a countdown.
      </p>

      <ul className="space-y-2.5">
        {rows.map((row) => (
          <ReadinessRow
            key={row.subject}
            row={row}
            busy={setDate.isPending && setDate.variables?.subject === row.subject}
            onSet={(isoDate) => setDate.mutate({ subject: row.subject, isoDate })}
          />
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function ReadinessRow({
  row,
  busy,
  onSet,
}: {
  row: Row;
  busy: boolean;
  onSet: (isoDate: string | null) => void;
}) {
  const { subject, readiness, examDate, days } = row;
  const strong = isStrong(readiness.score);
  const tone = scoreTone(readiness.score);

  // Soonest-exam urgency colours the countdown pill.
  const countdownTone: Tone =
    days != null && days >= 0 && days <= 7 ? "review" : "neutral";

  return (
    <li className="rounded-xl border border-border bg-bg/40 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <SubjectDot subject={subject} />
          <span className="truncate text-[0.95rem] font-medium text-ink">{subject}</span>
        </div>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">
          {readiness.score}%
        </span>
      </div>

      <div className="mt-2">
        <ProgressBar
          value={readiness.score / 100}
          tone={tone}
          className={strong ? "[&>div]:bg-emerald-500" : undefined}
        />
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-3">
        <span className="flex items-center gap-1 text-xs text-muted">
          <CalendarClock size={13} />
          {examDate && days != null ? (
            <Pill tone={countdownTone}>{countdownLabel(days)}</Pill>
          ) : (
            <span>No exam date</span>
          )}
        </span>

        <div className="flex items-center gap-1.5">
          {/* Native date input, styled minimally with tokens. Changing it sets
              the date; an empty value (cleared via the picker) clears it. */}
          <input
            type="date"
            aria-label={`Exam date for ${subject}`}
            value={examDate ?? ""}
            disabled={busy}
            onChange={(e) => onSet(e.target.value ? e.target.value : null)}
            className="rounded-lg border border-border bg-surface px-2 py-1 text-xs text-ink outline-none transition-colors hover:border-ink/20 focus-visible:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/30 disabled:opacity-50 [color-scheme:light] dark:[color-scheme:dark]"
          />
          {examDate && (
            <button
              type="button"
              aria-label={`Clear exam date for ${subject}`}
              title="Clear exam date"
              disabled={busy}
              onClick={() => onSet(null)}
              className="grid h-6 w-6 place-items-center rounded-md text-muted transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:opacity-50"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
