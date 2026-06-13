/**
 * Canvas colour helpers for the concept Graph view.
 *
 * `react-force-graph-2d` paints to a `<canvas>`, so it can't use Tailwind
 * classes or `rgb(var(--token))` strings — it needs concrete colour values.
 * These helpers read the live theme tokens (which flip between light/dark via
 * the `.dark` class on <html>) from `getComputedStyle`, so the graph stays in
 * sync with the rest of the reading-room palette without hard-coding hexes.
 *
 * Subjects get a calm, deterministic hue from the SAME hash `SubjectDot` uses
 * (`web/src/components/ui.tsx`), so a subject's dot in Progress and its nodes
 * here share one colour. Saturation/lightness stay muted to avoid garish tones.
 */

/** The CSS-variable theme tokens, resolved to `rgb(r g b)` triplets. */
export interface ThemeColors {
  bg: string;
  surface: string;
  border: string;
  ink: string;
  muted: string;
  accent: string;
  review: string;
}

const TOKENS = [
  "bg",
  "surface",
  "border",
  "ink",
  "muted",
  "accent",
  "review",
] as const;

const FALLBACK: ThemeColors = {
  bg: "rgb(250 249 246)",
  surface: "rgb(255 255 255)",
  border: "rgb(230 226 219)",
  ink: "rgb(28 27 25)",
  muted: "rgb(116 112 104)",
  accent: "rgb(79 70 229)",
  review: "rgb(180 83 9)",
};

/**
 * Read the current theme tokens off `:root`. Each `--token` is stored as a bare
 * `r g b` triple (e.g. `250 249 246`), so we wrap it in `rgb(...)`. Returns a
 * sensible light-mode fallback if called before the DOM is ready.
 */
export function readThemeColors(): ThemeColors {
  if (typeof window === "undefined") return FALLBACK;
  const styles = getComputedStyle(document.documentElement);
  const out = {} as ThemeColors;
  for (const token of TOKENS) {
    const raw = styles.getPropertyValue(`--${token}`).trim();
    out[token] = raw ? `rgb(${raw})` : FALLBACK[token];
  }
  return out;
}

/**
 * Add an alpha channel to a CSS colour, preserving its function. Works for both
 * resolved theme tokens (`rgb(250 249 246)` -> `rgb(250 249 246 / 0.4)`) and the
 * `hsl(...)` subject hues (`hsl(210 50% 52%)` -> `hsl(210 50% 52% / 0.4)`), so it
 * can be used uniformly across node fills and theme strokes.
 */
export function withAlpha(color: string, alpha: number): string {
  const fn = color.slice(0, color.indexOf("(")).trim() || "rgb";
  const inner = color
    .slice(color.indexOf("(") + 1, color.lastIndexOf(")"))
    .trim();
  return `${fn}(${inner} / ${alpha})`;
}

/**
 * Deterministic calm hue for a subject — identical hash to `SubjectDot`. Tuned
 * a touch more saturated than the 8px dot so nodes read at a glance, but still
 * muted (50% sat / 52% light) to stay within the quiet palette.
 */
export function subjectColor(subject: string): string {
  let h = 0;
  for (let i = 0; i < subject.length; i++) {
    h = (h * 31 + subject.charCodeAt(i)) % 360;
  }
  return `hsl(${h} 50% 52%)`;
}
