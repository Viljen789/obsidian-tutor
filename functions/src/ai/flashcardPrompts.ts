/**
 * System + user prompt builders for the model-written Q/A flashcards.
 *
 * House style (shared with ai/prompts.ts): intuition-first, no filler, tight
 * because output is capped (TOKEN_CAPS.flashcards). These cards complement the
 * instant note-derived cloze cards, so they should test UNDERSTANDING and
 * RECALL the cloze blanks can't reach — definitions in the learner's own words,
 * the "why", a small applied case — not just re-blank the same sentences.
 */

export function flashcardsSystemPrompt(count: number): string {
  return [
    `You write exactly ${count} flashcards that drill fast recall of ONE concept.`,
    "Each card is a tight question/answer pair:",
    '  - "front": one self-contained question. No multiple choice, no numbering, no preamble.',
    '  - "back": the concise, correct answer — a sentence or two at most, the key idea only.',
    '  - "hint" (optional): a one-line nudge that points at the answer without giving it away.',
    "Favor a MIX: a crisp definition, a 'why/trade-off' card, and one applied 'what happens if…' card.",
    "Test understanding and recall the learner can self-check in seconds — these complement",
    "fill-in-the-blank cards, so prefer questions over restating a single sentence verbatim.",
    "Ground every card strictly in the supplied notes; never invent facts beyond them.",
  ].join("\n");
}

export function flashcardsUserPrompt(args: {
  title: string;
  subject: string;
  bodyMarkdown: string;
  count: number;
}): string {
  return [
    `Write ${args.count} recall flashcards for "${args.title}" (subject: ${args.subject}).`,
    "",
    "Concept notes (the ground truth — base every card on these):",
    "---",
    args.bodyMarkdown.trim() || "(no additional notes — base the cards on the concept title)",
    "---",
  ].join("\n");
}
