/**
 * A GitHub-style calendar heatmap of daily review activity, drawn as inline SVG
 * (no chart lib — keeps the bundle lean and dark-mode handling trivial). Weeks
 * are columns, the seven weekdays are rows, and each cell's fill is the `accent`
 * token at an opacity that scales with that day's review count. Empty days read
 * as a faint ink wash so the grid's shape is always legible.
 *
 * The input is the chronological, gap-free day list from `reviewHeatmap`, so we
 * never have to reason about missing days here — just lay them out.
 */
import { useMemo } from "react";
import type { HeatmapCell } from "../lib/analytics";

const CELL = 11; // square edge, px
const GAP = 3; // gap between squares, px
const STEP = CELL + GAP;
const ROWS = 7; // weekdays, Sun..Sat (getDay order)
const LEFT_PAD = 22; // room for weekday labels
const TOP_PAD = 16; // room for month labels

/** Five-stop opacity ramp for the accent fill; index 0 is the empty-day wash. */
const LEVEL_OPACITY = [0, 0.18, 0.4, 0.66, 1] as const;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Month abbreviation for a 0..11 index, defensively bounded. */
function monthName(monthIndex: number): string {
  return MONTHS[monthIndex] ?? "";
}

/** Parse a `YYYY-MM-DD` key into a *local* Date (no UTC shift). */
function parseDayKey(key: string): Date {
  const parts = key.split("-");
  const y = Number(parts[0] ?? 0);
  const m = Number(parts[1] ?? 1);
  const d = Number(parts[2] ?? 1);
  return new Date(y, m - 1, d);
}

/** Short label for a cell's tooltip — "3 reviews · Jun 10" / "No reviews · Jun 10". */
function cellTitle(count: number, date: Date): string {
  const when = `${monthName(date.getMonth())} ${date.getDate()}`;
  if (count === 0) return `No reviews · ${when}`;
  return `${count} review${count === 1 ? "" : "s"} · ${when}`;
}

interface PositionedCell {
  cell: HeatmapCell;
  date: Date;
  col: number;
  row: number;
  level: number;
  /** Resolved accent opacity for this level; 0 for empty days (use the wash). */
  opacity: number;
}

export function Heatmap({ data }: { data: HeatmapCell[] }) {
  const { cells, weeks, monthLabels, max } = useMemo(() => {
    const list = data ?? [];

    // Bucket counts into 1..4 (0 stays 0) by quartiles of the busiest day, so the
    // ramp adapts to whether "a lot" means 3 reviews or 30.
    const peak = list.reduce((m, c) => Math.max(m, c.count), 0);
    const levelFor = (count: number): number => {
      if (count <= 0) return 0;
      if (peak <= 1) return 4;
      const ratio = count / peak;
      if (ratio <= 0.25) return 1;
      if (ratio <= 0.5) return 2;
      if (ratio <= 0.75) return 3;
      return 4;
    };

    // The first cell's weekday sets the row offset for column 0 so real
    // calendar weekdays line up across columns (leading blanks left empty).
    const firstCell = list[0];
    const firstDow = firstCell ? parseDayKey(firstCell.date).getDay() : 0;

    const positioned: PositionedCell[] = list.map((cell, i) => {
      const slot = firstDow + i; // linear weekday slot from the grid origin
      const level = levelFor(cell.count);
      return {
        cell,
        date: parseDayKey(cell.date),
        col: Math.floor(slot / ROWS),
        row: slot % ROWS,
        level,
        opacity: LEVEL_OPACITY[level] ?? 1,
      };
    });

    const lastCell = positioned[positioned.length - 1];
    const weekCount = lastCell ? lastCell.col + 1 : 0;

    // One month label per column where a new month first appears, anchored to
    // the column that holds that month's earliest visible day.
    const labels: { col: number; text: string }[] = [];
    let lastMonth = -1;
    for (const p of positioned) {
      const mo = p.date.getMonth();
      if (mo !== lastMonth) {
        // Avoid stacking a label right on top of the previous one.
        const prev = labels[labels.length - 1];
        if (!prev || p.col - prev.col >= 2) {
          labels.push({ col: p.col, text: monthName(mo) });
        }
        lastMonth = mo;
      }
    }

    return { cells: positioned, weeks: weekCount, monthLabels: labels, max: peak };
  }, [data]);

  const width = LEFT_PAD + Math.max(weeks, 1) * STEP;
  const height = TOP_PAD + ROWS * STEP;

  // Weekday guides: Mon / Wed / Fri, the GitHub convention.
  const weekdayLabels: { row: number; text: string }[] = [
    { row: 1, text: "Mon" },
    { row: 3, text: "Wed" },
    { row: 5, text: "Fri" },
  ];

  return (
    <figure className="m-0 w-full overflow-x-auto">
      {/* `text-accent` sets currentColor; cell fills use it at varying opacity,
          so the whole grid re-tints automatically in dark mode. */}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label={`Review activity heatmap. Busiest day: ${max} review${max === 1 ? "" : "s"}.`}
        className="max-w-full text-accent"
      >
        {/* Month labels along the top. */}
        {monthLabels.map((m, i) => (
          <text
            key={`mo-${i}`}
            x={LEFT_PAD + m.col * STEP}
            y={10}
            className="fill-muted"
            style={{ fontSize: 9 }}
          >
            {m.text}
          </text>
        ))}

        {/* Weekday guides down the left. */}
        {weekdayLabels.map((w) => (
          <text
            key={`wd-${w.row}`}
            x={0}
            y={TOP_PAD + w.row * STEP + CELL - 2}
            className="fill-muted"
            style={{ fontSize: 9 }}
          >
            {w.text}
          </text>
        ))}

        {/* The day cells. Empty days use a faint ink wash (via class); active
            days paint the accent (currentColor) at their ramp opacity. */}
        {cells.map((p) => (
          <rect
            key={p.cell.date}
            x={LEFT_PAD + p.col * STEP}
            y={TOP_PAD + p.row * STEP}
            width={CELL}
            height={CELL}
            rx={2.5}
            ry={2.5}
            fill={p.level === 0 ? undefined : "currentColor"}
            fillOpacity={p.level === 0 ? undefined : p.opacity}
            className={p.level === 0 ? "fill-ink/[0.06]" : undefined}
          >
            <title>{cellTitle(p.cell.count, p.date)}</title>
          </rect>
        ))}
      </svg>

      {/* Legend — Less … More across the same five stops. */}
      <figcaption className="mt-2 flex items-center gap-1.5 text-[0.7rem] text-muted">
        <span>Less</span>
        <svg
          width={5 * STEP - GAP}
          height={CELL}
          viewBox={`0 0 ${5 * STEP - GAP} ${CELL}`}
          className="text-accent"
          aria-hidden
        >
          {LEVEL_OPACITY.map((op, i) => (
            <rect
              key={i}
              x={i * STEP}
              y={0}
              width={CELL}
              height={CELL}
              rx={2.5}
              ry={2.5}
              fill="currentColor"
              fillOpacity={i === 0 ? undefined : op}
              className={i === 0 ? "fill-ink/[0.06]" : undefined}
            />
          ))}
        </svg>
        <span>More</span>
      </figcaption>
    </figure>
  );
}
