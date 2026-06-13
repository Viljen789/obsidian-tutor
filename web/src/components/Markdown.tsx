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

import "katex/dist/katex.min.css";
import "highlight.js/styles/github.css";

/** URL scheme we rewrite `[[wikilinks]]` to before handing markdown to react-markdown. */
const WIKI_SCHEME = "wiki:";

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
}) {
  const navigate = useNavigate();
  // Always normalise the vault's two Obsidian-isms: lift single-line `$$…$$`
  // into display math, and turn `[[wikilinks]]` into intercept-able links. With
  // no resolver, those links degrade to quiet text in the `a` renderer below.
  const source = rewriteWikilinks(normaliseDisplayMath(children));

  return (
    <div className={clsx("prose-reading", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          rehypeKatex,
          // `ignoreMissing` keeps an unknown language label from throwing; the
          // block just renders unhighlighted.
          [rehypeHighlight, { ignoreMissing: true }],
        ]}
        // react-markdown strips URLs with non-standard protocols by default,
        // which would empty our `wiki:` hrefs. Preserve those; defer everything
        // else to the safe default transform.
        urlTransform={(url) =>
          url.startsWith(WIKI_SCHEME) ? url : defaultUrlTransform(url)
        }
        components={{
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
