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
 * - `tags`    : frontmatter `tags` (array or inline string), normalized.
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
    tags: normalizeTags(frontmatter.tags),
    bodyMarkdown,
    wikilinks: extractWikilinks(bodyMarkdown),
    frontmatter,
  };
}
