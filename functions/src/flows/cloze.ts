/**
 * Pure cloze-card extraction from a concept's note body.
 *
 * A cloze card is an instant, zero-cost recall card: take a sentence that
 * defines a **bolded** term, blank the term out of the sentence (the `front`),
 * and put the term on the `back`. No model call, no I/O, no clock — given the
 * same body it always yields the same cards, so it is trivially unit-testable
 * and safe to run on every deck build.
 *
 * Heuristic (deliberately conservative — a wrong cloze is worse than none):
 *   - Only mine prose lines. Skip fenced code (``` … ```), display math (`$$`),
 *     headings (`# …`), list/quote markers, and wikilink-only lines.
 *   - A candidate line must contain a `**bolded**` term. We treat that term as
 *     the answer and blank every occurrence of it in the sentence.
 *   - We keep the term only if the remaining sentence still carries enough
 *     context to be answerable (a bare "**X**." gives the learner nothing).
 *   - Deterministic order (source order), de-duplicated by answer term, capped
 *     at `max`. NEVER throws; returns `[]` when nothing suitable is found.
 */
import type { Flashcard } from "@tutor/shared";

/** A run of N underscores stands in for the blanked term on the card front. */
const BLANK = "___";

/** Matches a bolded run: **term** (non-greedy, no nested newlines). */
const BOLD_RE = /\*\*(.+?)\*\*/g;

/** Inline math span `$ … $` — stripped from the displayed sentence. */
const INLINE_MATH_RE = /\$[^$]*\$/g;

/**
 * Extract up to `max` cloze cards from `body`. Pure and deterministic.
 *
 * @param conceptId stable concept id, used to build card ids
 * @param body      the concept's raw markdown (frontmatter already stripped)
 * @param max       hard cap on cards returned (<= 0 yields `[]`)
 */
export function extractClozeCards(
  conceptId: string,
  body: string,
  max: number,
): Flashcard[] {
  if (!conceptId || typeof body !== "string" || !Number.isFinite(max) || max <= 0) {
    return [];
  }

  const lines = body.split(/\r?\n/);
  const cards: Flashcard[] = [];
  const seenTerms = new Set<string>(); // de-dupe by lowercased answer term

  let inFence = false; // inside a ``` … ``` block
  let inMathBlock = false; // inside a $$ … $$ block

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // --- block toggles (skip the whole region, fences/math included) --------
    if (isFenceDelimiter(line)) {
      inFence = !inFence;
      continue;
    }
    if (isMathBlockDelimiter(line)) {
      inMathBlock = !inMathBlock;
      continue;
    }
    if (inFence || inMathBlock) continue;

    // --- per-line skips ------------------------------------------------------
    if (!shouldMineLine(line)) continue;

    const card = clozeFromLine(line, conceptId, cards.length, seenTerms);
    if (card) {
      cards.push(card);
      if (cards.length >= max) break;
    }
  }

  return cards;
}

/** ``` or ```lang — a fenced-code delimiter (also handles ~~~ fences). */
function isFenceDelimiter(line: string): boolean {
  return /^(```|~~~)/.test(line);
}

/** A line that is exactly `$$` — opens/closes a display-math block. */
function isMathBlockDelimiter(line: string): boolean {
  return line === "$$";
}

/**
 * Is this prose worth mining? Rejects structural / non-sentence lines so we only
 * ever blank terms out of real definitions.
 */
function shouldMineLine(line: string): boolean {
  if (line.length === 0) return false;
  if (line.startsWith("#")) return false; // heading
  if (line.startsWith(">")) return false; // blockquote
  if (line.startsWith("|")) return false; // table row
  if (/^[-*+]\s+/.test(line) && !line.includes("**")) return false; // plain bullet
  if (/^\d+\.\s+/.test(line) && !line.includes("**")) return false; // ordered item
  if (line.includes("$$")) return false; // inline display math
  if (!line.includes("**")) return false; // no bolded term → nothing to blank

  // A line that is ONLY a wikilink (e.g. "[[Indexing]]") carries no definition.
  if (/^\[\[[^\]]+\]\]\.?$/.test(line)) return false;

  return true;
}

/**
 * Turn one prose line into a cloze card, or return `null` if it doesn't yield a
 * usable blank. Picks the FIRST bolded term as the answer, blanks every
 * occurrence of it, and strips surrounding markdown so the front reads cleanly.
 */
function clozeFromLine(
  line: string,
  conceptId: string,
  index: number,
  seenTerms: Set<string>,
): Flashcard | null {
  BOLD_RE.lastIndex = 0;
  const firstBold = BOLD_RE.exec(line);
  const captured = firstBold?.[1];
  if (!captured) return null;

  const term = captured.trim();
  if (!isUsableTerm(term)) return null;

  const key = term.toLowerCase();
  if (seenTerms.has(key)) return null;

  // Blank EVERY occurrence of the term (bolded or bare) so the answer never
  // leaks elsewhere in the sentence, then clean up the rest of the markdown.
  const front = buildFront(line, term);
  if (!front) return null;

  // Reject fronts that lost all context — a card that is just "___." is useless.
  if (!hasEnoughContext(front)) return null;

  seenTerms.add(key);
  return {
    id: `${conceptId}_fc_cloze_${index + 1}`,
    conceptId,
    kind: "cloze",
    front,
    back: term,
    hint: lengthHint(term),
  };
}

/**
 * Build the card front: strip bold markers, blank the answer term wherever it
 * appears, drop inline math, soften wikilink syntax, and tidy whitespace.
 */
function buildFront(line: string, term: string): string {
  // 1. Remove bold markers so "**X**" becomes "X" before we blank by word.
  let text = line.replace(BOLD_RE, "$1");

  // 2. Blank every whole-word, case-insensitive occurrence of the term.
  const termRe = new RegExp(`\\b${escapeRegExp(term)}\\b`, "gi");
  text = text.replace(termRe, BLANK);

  // 3. Strip inline math spans — they don't read well with a blank in them.
  text = text.replace(INLINE_MATH_RE, "");

  // 4. Soften wikilinks: "[[Indexing|index]]" → "index", "[[Indexing]]" → "Indexing".
  text = text.replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, "$1").replace(/\[\[([^\]]+)\]\]/g, "$1");

  // 5. Collapse whitespace and a few cosmetic artifacts.
  return text.replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
}

/** A term is usable if it's a short-ish word/phrase, not a sentence or symbol. */
function isUsableTerm(term: string): boolean {
  if (term.length < 2 || term.length > 60) return false;
  if (!/[A-Za-z0-9]/.test(term)) return false; // must contain a real character
  // Avoid blanking a whole clause: cap the word count.
  if (term.split(/\s+/).length > 6) return false;
  return true;
}

/**
 * Does the blanked front still teach anything? Require at least three "content"
 * tokens around the blank so the learner has a real prompt, not "___ is key."
 */
function hasEnoughContext(front: string): boolean {
  const withoutBlank = front.replace(new RegExp(BLANK, "g"), " ");
  const words = withoutBlank.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
  return words.length >= 3 && front.includes(BLANK);
}

/** A gentle hint: the term's length, e.g. "6 letters" (a soft nudge, not the word). */
function lengthHint(term: string): string {
  const letters = term.replace(/[^A-Za-z]/g, "").length;
  return letters > 0 ? `${letters} letters` : `${term.length} characters`;
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
