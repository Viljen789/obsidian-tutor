/**
 * Thin, dependency-free helpers around the browser's Web Speech API
 * (`window.speechSynthesis`). No backend, no cost — the platform reads the
 * text aloud. Everything that can be pure is pure (`markdownToSpeech`,
 * `speechSupported`); the `speak` controller is the only stateful piece and it
 * stays small, owning a single utterance at a time.
 *
 * Quirk worth knowing: `speechSynthesis` is a *global* queue that keeps talking
 * across React unmounts and route changes. Callers must therefore `cancel()`
 * on unmount — the returned controls and the standalone `cancel()` both do.
 */

/** True when the SpeechSynthesis API is available (SSR- and old-browser-safe). */
export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

// ---------------------------------------------------------------------------
// markdownToSpeech — strip Markdown / LaTeX / Obsidian syntax to clean prose.
// ---------------------------------------------------------------------------

/**
 * Turn rendered-as-Markdown source into plain, speakable prose. This is a
 * best-effort flattener, not a parser: it removes the *visual* scaffolding a
 * screen reader would otherwise mispronounce (hashes, asterisks, backticks,
 * `$…$` math, bracket noise) while preserving sentence text and order.
 *
 * Order matters — image embeds (`![[…]]`) are dropped before bare wikilinks
 * (`[[…]]`) are unwrapped, since both share `[[…]]` and only the leading `!`
 * distinguishes them. Fenced code blocks are removed wholesale (their contents
 * read terribly), then inline code, then the rest. Pure and defensive: any
 * non-string input yields "".
 */
export function markdownToSpeech(md: string): string {
  if (typeof md !== "string" || md.length === 0) return "";

  let s = md;

  // Normalise line endings so block-level regexes behave.
  s = s.replace(/\r\n?/g, "\n");

  // Fenced code blocks (``` … ``` and ~~~ … ~~~) — drop entirely.
  s = s.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, "");

  // Obsidian image embeds: ![[name]] / ![[name|size]] — drop entirely.
  s = s.replace(/!\[\[[^\]]*?\]\]/g, "");

  // Standard image syntax: ![alt](url) — drop (alt text is usually noise).
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "");

  // Wikilinks: [[Target]] / [[Target|alias]] — speak the alias, else target.
  s = s.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_m, target, alias) =>
    (alias ?? target ?? "").trim(),
  );

  // Markdown links: [text](url) — keep the visible text only.
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Display + inline math: $$ … $$ then $ … $ — drop the math (unspeakable).
  s = s.replace(/\$\$[\s\S]*?\$\$/g, " ");
  s = s.replace(/\$[^$\n]*\$/g, " ");

  // Inline code spans: `code` — keep the inner text, lose the backticks.
  s = s.replace(/`([^`]*)`/g, "$1");

  // HTML comments and raw tags.
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "");

  // Headings: leading #'s. ATX setext underlines (=== / ---) → drop the line.
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  s = s.replace(/^[ \t]*(=+|-{3,})[ \t]*$/gm, "");

  // Blockquotes: leading > markers.
  s = s.replace(/^[ \t]*>+[ \t]?/gm, "");

  // List bullets and ordered markers at line start: -, *, +, "1." etc.
  s = s.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "");

  // Horizontal rules on their own line.
  s = s.replace(/^[ \t]*(?:\*{3,}|_{3,}|-{3,})[ \t]*$/gm, "");

  // Emphasis / bold / strikethrough markers: ** __ * _ ~~. Strip the symbols,
  // keep the words. Do the doubled forms first so singles don't fragment them.
  s = s.replace(/(\*\*|__|~~)(.*?)\1/g, "$2");
  s = s.replace(/(\*|_)(.*?)\1/g, "$2");

  // Tidy whitespace: collapse 3+ blank lines, trim trailing spaces, then
  // collapse remaining runs of whitespace into single spaces sentence-safely.
  s = s.replace(/[ \t]+$/gm, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/[ \t]{2,}/g, " ");

  return s.trim();
}

// ---------------------------------------------------------------------------
// speak — minimal single-utterance controller over speechSynthesis.
// ---------------------------------------------------------------------------

/** Callbacks + tuning for a single spoken utterance. */
export interface SpeakOptions {
  /** Fired on word/sentence boundaries — useful for progress / highlighting. */
  onBoundary?: (ev: SpeechSynthesisEvent) => void;
  /** Fired once when speech finishes naturally, is cancelled, or errors. */
  onEnd?: () => void;
  /** Speaking rate; ~1.0 is natural. Clamped to the spec range 0.1–10. */
  rate?: number;
}

/** Handle to the in-flight utterance returned by {@link speak}. */
export interface SpeechControls {
  /** Stop speaking and clear the queue. Safe to call repeatedly. */
  cancel: () => void;
  /** Pause the current utterance (no-op if not speaking). */
  pause: () => void;
  /** Resume a paused utterance (no-op if not paused). */
  resume: () => void;
  /** The underlying utterance, exposed for advanced callers. */
  utterance: SpeechSynthesisUtterance;
}

const DEFAULT_RATE = 1.0;

/**
 * Speak `text` immediately, cancelling anything already queued so there is only
 * ever one voice. Returns controls for pause / resume / cancel. `onEnd` fires
 * exactly once for whichever terminal event happens first (end / error /
 * cancel-driven end), so a component can reliably return to its idle state.
 *
 * No-op-safe when the API is unavailable: returns inert controls instead of
 * throwing, so callers don't need to branch on support twice.
 */
export function speak(text: string, opts: SpeakOptions = {}): SpeechControls {
  const utterance = new (window.SpeechSynthesisUtterance ??
    SpeechSynthesisUtterance)(text);

  if (!speechSupported()) {
    return {
      cancel: () => {},
      pause: () => {},
      resume: () => {},
      utterance,
    };
  }

  const synth = window.speechSynthesis;
  const rate = opts.rate ?? DEFAULT_RATE;
  utterance.rate = Math.max(0.1, Math.min(10, rate));

  // Default voice: let the platform choose, but prefer the system default if
  // the list has loaded. Voices populate asynchronously in some browsers, so
  // this is purely a nicety — leaving `voice` null also works fine.
  const voices = synth.getVoices();
  const preferred = voices.find((v) => v.default) ?? voices[0];
  if (preferred) utterance.voice = preferred;

  // Guarantee onEnd fires once across whichever terminal path we hit.
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    opts.onEnd?.();
  };

  if (opts.onBoundary) utterance.onboundary = opts.onBoundary;
  utterance.onend = finish;
  utterance.onerror = finish;

  // Some engines stall if a previous utterance is still draining; cancel first.
  synth.cancel();
  synth.speak(utterance);

  return {
    cancel: () => {
      // Detach handlers so the cancel-triggered onend can't re-fire callbacks,
      // then drive `finish()` ourselves for a deterministic single onEnd.
      utterance.onend = null;
      utterance.onerror = null;
      synth.cancel();
      finish();
    },
    pause: () => synth.pause(),
    resume: () => synth.resume(),
    utterance,
  };
}

/** Stop any and all speech globally. Use on unmount / route change. */
export function cancel(): void {
  if (speechSupported()) window.speechSynthesis.cancel();
}

/** Pause the global speech queue. */
export function pause(): void {
  if (speechSupported()) window.speechSynthesis.pause();
}

/** Resume the global speech queue. */
export function resume(): void {
  if (speechSupported()) window.speechSynthesis.resume();
}
