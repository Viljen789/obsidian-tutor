/**
 * Renders explanation / note markdown in the serif reading column.
 *
 * Beyond GitHub-flavoured markdown (tables, task lists) this renderer makes the
 * vault's source first-class:
 *   - LaTeX math: `$inline$` and `$$display$$` via remark-math + rehype-katex.
 *   - Code / assembly: fenced blocks are syntax-highlighted via rehype-highlight.
 *   - `[[wikilinks]]`: `[[Target]]` / `[[Target|alias]]` become in-app links to
 *     the target concept's Learn page, resolved by a caller-supplied
 *     `resolveWiki` (so this component never hard-codes a concept list). Targets
 *     that don't resolve render as quiet, non-link text — never a dead link.
 *
 * Styling lives in the `.prose-reading` class (see index.css), with the KaTeX
 * and highlight.js theme CSS imported here and toned down to suit the
 * paper-and-ink look.
 */
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { useNavigate } from "react-router-dom";
import { clsx } from "clsx";

// Individual highlight.js grammars. By default rehype-highlight registers
// lowlight's `common` set (~37 languages) and can pull in all ~190; passing an
// explicit `languages` record below restricts the bundle to just these, so the
// rest tree-shake away. Curated for this vault: databases (sql) and low-level /
// embedded work (c, cpp, x86asm, armasm, rust, go) plus the everyday set.
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import sql from "highlight.js/lib/languages/sql";
import bash from "highlight.js/lib/languages/bash";
import x86asm from "highlight.js/lib/languages/x86asm";
import armasm from "highlight.js/lib/languages/armasm";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import plaintext from "highlight.js/lib/languages/plaintext";

import "katex/dist/katex.min.css";
import "highlight.js/styles/github.css";

/**
 * The only syntax-highlighting grammars we ship. Keyed by highlight.js language
 * name; lowlight also derives the usual aliases (e.g. `js`, `ts`, `sh`, `py`,
 * `c++`, `asm`) from each grammar, so fences keep working with familiar labels.
 * Any language not listed here renders unhighlighted via `ignoreMissing`.
 */
const HIGHLIGHT_LANGUAGES = {
  javascript,
  typescript,
  python,
  c,
  cpp,
  sql,
  bash,
  x86asm,
  armasm,
  json,
  yaml,
  rust,
  go,
  java,
  plaintext,
};

/** URL scheme we rewrite `[[wikilinks]]` to before handing markdown to react-markdown. */
const WIKI_SCHEME = "wiki:";

/**
 * Utility classes for inline images so they sit calmly in the reading column:
 * full-width-capped, centred, with the same quiet 1px border + rounded corners
 * as the rest of the reading room. Dark-mode-safe via the shared `border-border`
 * token. Applied directly on the rendered `<img>` (the `.prose-reading img`
 * style lives elsewhere and we don't depend on it).
 */
const IMAGE_CLASS =
  "block mx-auto my-4 max-w-full h-auto rounded-xl border border-border";

/** The final path segment of an image reference (handles `/` and `\`, trims). */
function imageBasename(ref: string): string {
  const trimmed = ref.trim();
  const segments = trimmed.split(/[/\\]/);
  return (segments[segments.length - 1] ?? trimmed).trim();
}

/** True for absolute web URLs we should pass through to `<img src>` untouched. */
function isAbsoluteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/**
 * Markdown-escape image alt text so a stray `]` or `)` in a filename can't
 * break out of the generated `![alt](url)` syntax during pre-processing.
 */
function escapeImageAlt(alt: string): string {
  return alt.replace(/([[\]()])/g, "\\$1");
}

/**
 * Pre-process Obsidian *image* embeds — `![[name]]` / `![[name|size]]` — into
 * standard markdown images BEFORE the wikilink rewriter runs (it would
 * otherwise mangle `![[…]]` into a broken `![…](wiki:…)` link). The leading `!`
 * is the signal that distinguishes an image embed from a `[[wikilink]]`, so we
 * only consume `![[…]]` here and leave bare `[[…]]` for the wikilink pass.
 *
 * When `resolveAsset(name)` yields a URL we emit `![name](url)` (the optional
 * `|size` hint is dropped — sizing is governed by the reading column). When it
 * doesn't resolve, we emit a quiet italic placeholder — `*[image: name]*` —
 * rather than a broken image, so a missing asset never disrupts reading. (We
 * emit markdown italics rather than a styled HTML span because this pipeline
 * has no `rehype-raw`; raw HTML would render as literal text. House style: no
 * emoji in the placeholder.)
 */
function rewriteImageEmbeds(
  markdown: string,
  resolveAsset?: (name: string) => string | null,
): string {
  return markdown.replace(
    /!\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g,
    (_match, rawName: string) => {
      const name = rawName.trim();
      const url = resolveAsset?.(name) ?? null;
      if (url) {
        return `![${escapeImageAlt(name)}](${url})`;
      }
      // Unresolved -> quiet italic placeholder text.
      return `*[image: ${name}]*`;
    },
  );
}

/**
 * Rewrite Obsidian wikilinks to standard markdown links using a private scheme
 * so react-markdown parses them as anchors we can intercept. Supports
 * `[[Target]]` and `[[Target|alias]]`; the alias (or target) becomes the link
 * text, the target is URL-encoded into the href.
 *
 * Done as a tiny pre-process (rather than a remark plugin) to keep the surface
 * area small and easy to reason about; the resolution + navigation happens in
 * the custom `a` renderer below.
 */
function rewriteWikilinks(markdown: string): string {
  return markdown.replace(
    /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g,
    (_match, rawTarget: string, rawAlias?: string) => {
      const target = rawTarget.trim();
      const alias = (rawAlias ?? rawTarget).trim();
      // Escape characters that would break the link text / destination.
      const text = alias.replace(/([[\]])/g, "\\$1");
      return `[${text}](${WIKI_SCHEME}${encodeURIComponent(target)})`;
    },
  );
}

/**
 * Obsidian authors routinely write display math as a single line — `$$ … $$` —
 * and expect it centred on its own row. `micromark-extension-math` (under
 * remark-math) only treats `$$` as *display* math when the fences sit on their
 * own lines; a single-line `$$x$$` parses as inline. To match Obsidian, we lift
 * a standalone single-line `$$ … $$` paragraph onto three lines so it renders
 * as display math. We deliberately skip lines with surrounding prose (to avoid
 * disturbing inline `$$` use) and anything inside fenced code blocks.
 */
function normaliseDisplayMath(markdown: string): string {
  const lines = markdown.split("\n");
  let inFence = false;
  return lines
    .map((line) => {
      // Track ``` / ~~~ code fences so we never rewrite math-like text in code.
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;

      // A line that is *only* a `$$ … $$` expression (optional surrounding
      // whitespace), with non-empty, non-`$` content between the fences.
      const m = line.match(/^\s*\$\$(?!\$)([^$].*?)\$\$\s*$/);
      if (m?.[1]) return `$$\n${m[1].trim()}\n$$`;
      return line;
    })
    .join("\n");
}

export function Markdown({
  children,
  className,
  resolveWiki,
  resolveAsset,
}: {
  children: string;
  className?: string;
  /**
   * Resolve a wikilink target (the text inside `[[…]]`) to a conceptId, or
   * `null` if it doesn't match a known concept. Supplied by the caller so the
   * renderer stays decoupled from the concept list. When omitted, all
   * wikilinks render as quiet non-link text.
   */
  resolveWiki?: (target: string) => string | null;
  /**
   * Resolve an image-embed reference (e.g. `er-diagram.png`, or the path inside
   * a `![](…)`) to a concrete asset URL, or `null` if no asset matches.
   * Supplied by the caller (typically `buildAssetResolver(concept.assets)`) so
   * the renderer stays decoupled from the asset store. When omitted, image
   * embeds and relative-path images degrade to a quiet placeholder.
   */
  resolveAsset?: (name: string) => string | null;
}) {
  const navigate = useNavigate();
  // Always normalise the vault's Obsidian-isms. Order matters: resolve IMAGE
  // embeds (`![[…]]`) first so the wikilink rewriter never sees them — both use
  // `[[…]]`, and the leading `!` is the only signal that one is an image. Then
  // lift single-line `$$…$$` into display math, and turn the remaining
  // `[[wikilinks]]` into intercept-able links. With no resolver, image embeds
  // degrade to quiet placeholder text and wikilinks to quiet text below.
  const source = rewriteWikilinks(
    normaliseDisplayMath(rewriteImageEmbeds(children, resolveAsset)),
  );

  return (
    <div className={clsx("prose-reading", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          rehypeKatex,
          // Restrict to our curated grammar set (everything else tree-shakes
          // away). `ignoreMissing` keeps an unknown — or now-unregistered —
          // language label from throwing; the block just renders unhighlighted.
          [
            rehypeHighlight,
            { languages: HIGHLIGHT_LANGUAGES, ignoreMissing: true },
          ],
        ]}
        // react-markdown strips URLs with non-standard protocols by default,
        // which would empty our `wiki:` hrefs. Preserve those; defer everything
        // else to the safe default transform.
        urlTransform={(url) =>
          url.startsWith(WIKI_SCHEME) ? url : defaultUrlTransform(url)
        }
        components={{
          // Standard markdown images `![alt](path)`. Vault notes reference
          // images by bare/relative path, which won't load as-is, so resolve
          // the basename against the concept's assets first. Pass through paths
          // that are already absolute http(s) URLs; anything else that can't be
          // resolved becomes a quiet placeholder rather than a broken image.
          img: ({ src, alt }) => {
            const rawSrc = typeof src === "string" ? src : "";
            const name = alt && alt.trim() ? alt.trim() : imageBasename(rawSrc);
            const resolved = rawSrc ? resolveAsset?.(rawSrc) ?? null : null;
            const finalSrc = resolved
              ? resolved
              : isAbsoluteUrl(rawSrc)
                ? rawSrc.trim()
                : null;

            if (!finalSrc) {
              return (
                <span className="text-muted-foreground italic">
                  [image: {name}]
                </span>
              );
            }

            return (
              <img
                src={finalSrc}
                alt={alt ?? name}
                loading="lazy"
                className={IMAGE_CLASS}
              />
            );
          },
          a: ({ href, children }) => {
            // In-app wikilink: resolve to a concept and navigate via the router.
            if (href?.startsWith(WIKI_SCHEME)) {
              const target = decodeURIComponent(href.slice(WIKI_SCHEME.length));
              const conceptId = resolveWiki?.(target) ?? null;

              // Unresolved -> quiet text, so a missing note never breaks reading.
              if (!conceptId) {
                return <span className="wikilink-dead">{children}</span>;
              }

              return (
                <a
                  href={`/learn/${conceptId}`}
                  className="wikilink"
                  onClick={(e) => {
                    // Let modifier-clicks / middle-clicks open normally.
                    if (
                      e.metaKey ||
                      e.ctrlKey ||
                      e.shiftKey ||
                      e.altKey ||
                      e.button !== 0
                    )
                      return;
                    e.preventDefault();
                    navigate(`/learn/${conceptId}`);
                  }}
                >
                  {children}
                </a>
              );
            }

            // External link: open safely in a new tab (unchanged behaviour).
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
