/**
 * System + user prompt builders for the tutorChat callable (ask-a-follow-up).
 *
 * House style (see prompts.ts): intuition-first, tight, no filler. The one
 * difference from explainConcept/gradeAnswer is stance — this is a back-and-forth
 * with the learner during THEIR OWN revision, so full answers are fine; there is
 * no exam being sat to protect. Output is capped (TOKEN_CAPS.chat), so we steer
 * toward concise replies and clamp the transcript before it reaches the model.
 */
import type { ChatMessage } from "@tutor/shared";

/** Keep only the most recent turns so a long session can't blow the token budget. */
export const MAX_TRANSCRIPT_MESSAGES = 12;

export function chatSystemPrompt(): string {
  return [
    "You are a patient, encouraging tutor helping a learner revise from THEIR OWN study notes.",
    "Ground every answer in the supplied concept notes (title, subject, body). Lead with the",
    "intuition — the mental model or a concrete example — before any formal detail.",
    "This is the learner's private revision, NOT an exam being sat: you MAY explain fully and",
    "give away answers. If they seem confused or say something wrong, gently correct them and",
    "leave them with the right mental model.",
    "Be concise: aim for under 150 words, conversational, no headings or preamble. Answer the",
    "question directly — don't restate it back.",
    "Stay within the notes plus ordinary domain knowledge. If their question goes beyond what the",
    "notes cover, say so briefly and answer from general knowledge only if you're confident; never",
    "invent specifics (numbers, names, claims) that aren't supported.",
  ].join("\n");
}

/**
 * The user prompt = concept context, then the recent transcript rendered as a
 * readable dialogue ("Learner:" / "Tutor:"). `messages` is oldest-first and its
 * last entry is the new learner question; we clamp to the last
 * MAX_TRANSCRIPT_MESSAGES turns to bound input tokens.
 */
export function chatUserPrompt(args: {
  title: string;
  subject: string;
  bodyMarkdown: string;
  messages: ChatMessage[];
}): string {
  const recent = args.messages.slice(-MAX_TRANSCRIPT_MESSAGES);
  const transcript = recent
    .map((m) => `${m.role === "user" ? "Learner" : "Tutor"}: ${m.content.trim()}`)
    .join("\n");

  return [
    `Concept under discussion: "${args.title}" (subject: ${args.subject}).`,
    "",
    "The learner's notes for this concept (your ground truth):",
    "---",
    args.bodyMarkdown.trim() || "(no additional notes — work from the concept title)",
    "---",
    "",
    "Conversation so far (the last line is the new question to answer):",
    transcript,
    "",
    "Reply as the tutor.",
  ].join("\n");
}
