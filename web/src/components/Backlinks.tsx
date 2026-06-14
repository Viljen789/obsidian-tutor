/**
 * "Linked from" — the Obsidian backlinks panel. Given the concept on screen, it
 * surfaces the *other* notes that point at it, computed purely from the concept
 * graph already loaded by `useConcepts()` (no extra fetch).
 *
 * Two quiet groups, each only shown when non-empty:
 *  - "Linked from" — concepts whose `links` wikilink here (undirected "see also").
 *  - "Unlocks" — concepts that name this one as a prerequisite (what mastering
 *    it opens up).
 *
 * Every entry is a row that navigates to that concept's Learn view. The whole
 * panel renders `null` when there's nothing to show, so it never leaves an empty
 * box in the lesson margin. Styling reuses the shared reading-room primitives
 * and honours the passed `tone` (defaults to the Learn accent).
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, Link2, Unlock } from "lucide-react";
import type { Concept } from "@tutor/shared";
import { useConcepts } from "../lib/firestore-hooks";
import { findBacklinks, findDependents } from "../lib/backlinks";
import { Card, Eyebrow, SubjectDot, type Tone } from "./ui";

export function Backlinks({
  conceptId,
  tone = "accent",
}: {
  conceptId: string;
  tone?: Tone;
}) {
  const { data: concepts } = useConcepts();

  const backlinks = useMemo(
    () => findBacklinks(conceptId, concepts ?? []),
    [conceptId, concepts],
  );
  const dependents = useMemo(
    () => findDependents(conceptId, concepts ?? []),
    [conceptId, concepts],
  );

  // Nothing points here and nothing is unlocked — render no panel at all rather
  // than a hollow box.
  if (backlinks.length === 0 && dependents.length === 0) return null;

  return (
    <Card as="section" className="animate-fade p-5">
      {backlinks.length > 0 && (
        <Group
          icon={Link2}
          label="Linked from"
          concepts={backlinks}
          tone={tone}
        />
      )}

      {dependents.length > 0 && (
        <div className={backlinks.length > 0 ? "mt-5" : undefined}>
          <Group
            icon={Unlock}
            label="Unlocks"
            concepts={dependents}
            tone={tone}
          />
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A titled group of concept rows. Each row navigates to that concept's lesson.
// ---------------------------------------------------------------------------

function Group({
  icon: Icon,
  label,
  concepts,
  tone,
}: {
  icon: typeof Link2;
  label: string;
  concepts: Concept[];
  tone: Tone;
}) {
  const iconColor =
    tone === "review"
      ? "text-review"
      : tone === "neutral"
        ? "text-muted"
        : "text-accent";

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Icon size={14} className={iconColor} />
        <Eyebrow tone={tone}>{label}</Eyebrow>
        <span className="text-[0.7rem] font-medium tabular-nums text-muted">
          {concepts.length}
        </span>
      </div>

      <ul className="space-y-1.5">
        {concepts.map((c) => (
          <ConceptRow key={c.id} concept={c} />
        ))}
      </ul>
    </div>
  );
}

function ConceptRow({ concept }: { concept: Concept }) {
  const navigate = useNavigate();

  return (
    <li>
      <button
        type="button"
        onClick={() => navigate("/learn/" + concept.id)}
        className="group flex w-full items-center gap-2.5 rounded-xl border border-border bg-bg/40 px-3.5 py-2.5 text-left transition-colors hover:bg-ink/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
      >
        <SubjectDot subject={concept.subject} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.95rem] text-ink">
            {concept.title}
          </span>
          {concept.subject && (
            <span className="block truncate text-xs text-muted">
              {concept.subject}
            </span>
          )}
        </span>
        <ArrowUpRight
          size={15}
          className="shrink-0 text-muted/60 transition-colors group-hover:text-ink"
        />
      </button>
    </li>
  );
}
