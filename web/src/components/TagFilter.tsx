/**
 * TagFilter — a calm, multi-select row of tag pills for the Progress page.
 *
 * Each pill is a toggle: active pills are accent-tinted, inactive ones sit
 * quiet and neutral. Every pill carries the concept count for its tag, and a
 * "Clear" affordance appears only while at least one tag is active. Filter
 * semantics are OR/ANY (owned by `filterByTags`); this component is purely the
 * control surface — it reports toggles up via `onToggle` and never holds state.
 */
import { clsx } from "clsx";
import { Tag, X } from "lucide-react";
import { Eyebrow } from "./ui";
import type { TagCount } from "../lib/tags";

export function TagFilter({
  tags,
  selected,
  onToggle,
  onClear,
  className,
}: {
  /** All distinct tags with counts, already sorted (see `collectTags`). */
  tags: TagCount[];
  /** Currently-active tags (first-spelling), case-insensitive at the edges. */
  selected: Set<string>;
  /** Toggle a single tag on/off. */
  onToggle: (tag: string) => void;
  /** Clear the entire selection. */
  onClear: () => void;
  className?: string;
}) {
  if (tags.length === 0) return null;

  const activeCount = selected.size;

  return (
    <div className={clsx("flex flex-col gap-2.5", className)}>
      <div className="flex items-center gap-2">
        <Tag size={13} className="text-muted" />
        <Eyebrow>Filter by tag</Eyebrow>
        {activeCount > 0 && (
          <button
            type="button"
            onClick={onClear}
            className={clsx(
              "ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
              "text-muted transition-colors hover:bg-ink/[0.04] hover:text-ink",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20",
            )}
            aria-label="Clear tag filter"
          >
            <X size={12} />
            Clear
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {tags.map(({ tag, count }) => {
          const active = selected.has(tag);
          return (
            <button
              key={tag}
              type="button"
              onClick={() => onToggle(tag)}
              aria-pressed={active}
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium",
                "border transition-all duration-200 active:scale-[0.98]",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                active
                  ? "border-accent/30 bg-accent/10 text-accent focus-visible:ring-accent/40"
                  : "border-border bg-surface text-muted hover:bg-ink/[0.03] hover:text-ink focus-visible:ring-ink/20",
              )}
            >
              <span className="opacity-60">#</span>
              <span>{tag}</span>
              <span
                className={clsx(
                  "tabular-nums",
                  active ? "text-accent/70" : "text-muted/70",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
