/**
 * System + user prompt builders for the exam-day cheat-sheet generator.
 *
 * House style (shared with ai/prompts.ts): tight prompts, no filler. Here the
 * goal is the opposite of the teaching prompts — NOT to explain, but to DISTIL.
 * One dense, print-friendly revision sheet: key definitions, formulas, and
 * facts only, grounded strictly in the learner's own notes.
 *
 * Output is capped (TOKEN_CAPS.cheatsheet), so each concept's context is
 * trimmed before it reaches the model and the system prompt is explicit about
 * brevity — many concepts must fit one page within the budget.
 */

/** Hard cap on how much of each concept's body we feed the model, in chars. */
export const CHEATSHEET_CONTEXT_CHARS = 700;

/** Concept titles + trimmed bodies handed to the builder, in MOC/import order. */
export interface CheatSheetConcept {
  title: string;
  bodyMarkdown: string;
}

export function cheatSheetSystemPrompt(subject: string): string {
  return [
    `You are a meticulous study assistant building a one-page EXAM-DAY CHEAT SHEET for the subject "${subject}".`,
    "Your job is to DISTIL, not to teach. The reader already learned this material and now wants the densest possible last-minute refresher.",
    "",
    "Produce TIGHT GitHub-flavored Markdown that prints cleanly onto roughly ONE page:",
    "  - Group related concepts under short `##` section headings; keep headings to a handful of words.",
    "  - Under each heading, use compact bullet points: a bolded term followed by its shortest correct definition or key fact.",
    "  - Put formulas, equations, and notation in LaTeX: `$inline$` for terms in a line, `$$display$$` for a standalone formula.",
    "  - Prefer fragments over full sentences. Cut articles and filler words. Every line must earn its place.",
    "  - Capture the high-value, testable essentials: definitions, formulas, properties, key distinctions, common pitfalls, units.",
    "",
    "STRICT RULES:",
    "  - Ground EVERYTHING in the supplied notes. Do NOT invent facts, examples, or formulas beyond them.",
    "  - NO introduction, NO conclusion, NO preamble, NO meta-commentary, NO 'here is your cheat sheet'. Start directly with the first heading.",
    "  - NO long prose paragraphs, NO worked examples, NO study tips. This is a reference card, not a lesson.",
    "  - Be exhaustive about WHAT to include but ruthless about LENGTH. Density over completeness of explanation.",
  ].join("\n");
}

export function cheatSheetUserPrompt(args: {
  subject: string;
  concepts: CheatSheetConcept[];
}): string {
  const blocks = args.concepts.map((c, i) => {
    const body = c.bodyMarkdown.trim().replace(/\s+/g, " ").slice(0, CHEATSHEET_CONTEXT_CHARS);
    return [
      `### ${i + 1}. ${c.title}`,
      body || "(no notes — use the concept title only)",
    ].join("\n");
  });

  return [
    `Build the cheat sheet for "${args.subject}" from these ${args.concepts.length} concept notes (the ground truth — use only what is here):`,
    "",
    ...blocks,
    "",
    "Now write the single-page cheat sheet. Organize the material logically (you may merge, reorder, and group concepts into sensible sections); start immediately with the first `##` heading; no preamble.",
  ].join("\n");
}
