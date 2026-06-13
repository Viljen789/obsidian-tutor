/**
 * Pure markdown/frontmatter parsing for the ingestion pipeline.
 *
 * No I/O, no Firestore, no clock — `parseNote` turns one note's raw bytes into a
 * `ParsedNote`. The callable feeds it file contents read from the unzipped vault.
 */
import matter from "gray-matter";
import type { ParsedNote } from "./index";

/**
 * Matches Obsidian wikilinks and captures the *target* note name only:
 *   [[Target]]            -> "Target"
 *   [[Target|alias]]      -> "Target"   (alias dropped)
 *   [[Target#heading]]    -> "Target"   (heading dropped)
 *   [[Target#h|alias]]    -> "Target"
 * The target stops at the first '#', '|', or ']]'.
 */
const WIKILINK_RE = /\[\[([^\]#|]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** Normalize a frontmatter `tags` value into a clean string[]. */
function normalizeTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim()).filter((t) => t.length > 0);
  }
  if (typeof raw === "string") {
    // Allow comma- or space-separated inline tags ("a, b" or "a b").
    return raw
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  return [];
}

/**
 * Matches an inline Obsidian `#tag` and captures the tag name (without the `#`).
 *
 * Obsidian semantics:
 *  - the `#` must be at start-of-line or preceded by whitespace (the `(?<=^|\s)`
 *    lookbehind), so `word#anchor` and `https://x#frag` are NOT tags;
 *  - the first character after `#` must be a Unicode-ish letter (NOT a digit and
 *    NOT a space). Requiring a letter excludes markdown headings (`# Heading` —
 *    `#` then a space) and bare numbers (`#123`, which Obsidian rejects);
 *  - the remainder may contain letters, digits, `-`, `_` and `/` (nested tags
 *    like `#a/b`).
 */
const INLINE_TAG_RE = /(?<=^|\s)#([\p{L}][\p{L}\p{N}/_-]*)/gu;

/**
 * Strip regions where a `#` must not be read as a tag:
 *  - fenced code blocks (``` ``` ``` ``` ``` ``` / `~~~ ... ~~~`), and
 *  - inline code spans (`` `...` ``).
 * Replaced with blank lines / spaces so byte offsets and the start-of-line
 * anchor outside the stripped regions stay meaningful.
 */
function stripCodeForTags(body: string): string {
  // Fenced blocks first: a run of >=3 backticks or tildes, to the matching fence.
  let out = body.replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1?\2[^\n]*$/gm, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  // Any dangling/unterminated fence: blank out from the fence to end of input.
  out = out.replace(/^[ \t]*(`{3,}|~{3,})[\s\S]*$/m, (m) => m.replace(/[^\n]/g, " "));
  // Inline code spans (single or multi backtick runs on one line).
  out = out.replace(/(`+)(?:[^`\n]|(?!\1)`)*\1/g, (m) => " ".repeat(m.length));
  return out;
}

/**
 * Extract inline Obsidian `#tags` from a note body (deduped, order-preserving,
 * case-insensitive de-dup), ignoring headings and anything inside code.
 */
export function extractInlineTags(body: string): string[] {
  const scannable = stripCodeForTags(body);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of scannable.matchAll(INLINE_TAG_RE)) {
    const tag = match[1];
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}

/** Merge frontmatter + inline tags, de-duped case-insensitively, order-preserving. */
function mergeTags(frontmatterTags: string[], inlineTags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of [...frontmatterTags, ...inlineTags]) {
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}

/** Top-level folder of a vault-relative path, e.g. "Databases/Indexing.md" -> "Databases". */
function topLevelFolder(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.?\/+/, "");
  const segments = normalized.split("/").filter((s) => s.length > 0);
  // If the file sits at the vault root there is no folder; fall back to "General".
  return segments.length > 1 ? (segments[0] as string) : "General";
}

/** Filename without directories or the `.md` extension. */
function fileBaseName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const last = normalized.split("/").pop() ?? normalized;
  return last.replace(/\.md$/i, "");
}

/** Extract every wikilink target (deduped, order-preserving). */
export function extractWikilinks(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of body.matchAll(WIKILINK_RE)) {
    const target = match[1]?.trim();
    if (target && !seen.has(target.toLowerCase())) {
      seen.add(target.toLowerCase());
      out.push(target);
    }
  }
  return out;
}

/**
 * Parse a single markdown file's bytes into a `ParsedNote` (pure).
 *
 * - `title`   : frontmatter `title`, else the filename (sans `.md`).
 * - `subject` : frontmatter `subject`, else the top-level folder of `path`.
 * - `tags`    : frontmatter `tags` merged with inline body `#tags` (deduped).
 * - wikilinks : `[[Target]]` / `[[Target|alias]]` / `[[Target#heading]]` targets.
 * - body      : note content with frontmatter removed.
 */
export function parseNote(path: string, raw: string): ParsedNote {
  const parsed = matter(raw);
  const frontmatter = (parsed.data ?? {}) as Record<string, unknown>;
  const bodyMarkdown = parsed.content.trim();

  const fmTitle = frontmatter.title;
  const title =
    typeof fmTitle === "string" && fmTitle.trim().length > 0
      ? fmTitle.trim()
      : fileBaseName(path);

  const fmSubject = frontmatter.subject;
  const subject =
    typeof fmSubject === "string" && fmSubject.trim().length > 0
      ? fmSubject.trim()
      : topLevelFolder(path);

  return {
    sourcePath: path.replace(/\\/g, "/").replace(/^\.?\/+/, ""),
    title,
    subject,
    tags: mergeTags(normalizeTags(frontmatter.tags), extractInlineTags(bodyMarkdown)),
    bodyMarkdown,
    wikilinks: extractWikilinks(bodyMarkdown),
    frontmatter,
  };
}
