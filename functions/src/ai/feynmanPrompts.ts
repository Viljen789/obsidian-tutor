/**
 * Feynman "explain it back" prompts + schema.
 *
 * This is the inverse of grading a question: the learner has produced a free-text
 * EXPLANATION of a whole concept (teaching-to-learn), and we critique that
 * explanation against the concept notes for correctness, completeness, and
 * clarity. The rubric is deliberately kind-but-honest — the payoff is the
 * `refinedExplanation`: a tight, correct re-explanation the learner can study.
 *
 * Mirrors the style of ai/schemas.ts + ai/prompts.ts. The numeric `score` range
 * is described for the model but NOT trusted — the caller clamps it to [0,1]
 * (structured outputs constrain shape, not bounds; see ai/index.ts).
 */
import { z } from "zod";

// --- schema ---------------------------------------------------------------

/**
 * Critique of a learner's own explanation. `score` carries a described range
 * (0..1) the model cannot be trusted to honour — the flow clamps it in code.
 */
export const critiqueSchema = z.object({
  score: z
    .number()
    .describe(
      "Completeness + correctness of the explanation, 0..1. The fraction of the " +
        "concept's key ideas the explanation gets right and clearly conveys.",
    ),
  feedback: z
    .string()
    .min(1)
    .describe(
      "Honest, encouraging, intuition-first read of the explanation as a whole, " +
        "addressed directly to the learner ('you'). Not a list — a short paragraph.",
    ),
  whatWasRight: z
    .array(z.string())
    .describe(
      "Specific ideas the explanation got right or expressed well. Empty only if " +
        "nothing was right.",
    ),
  whatWasMissing: z
    .array(z.string())
    .describe(
      "Specific gaps, errors, vague spots, or misconceptions in the explanation — " +
        "what a complete, correct version would add or fix.",
    ),
  refinedExplanation: z
    .string()
    .min(1)
    .describe(
      "A tight, correct re-explanation of the concept the learner can study: " +
        "their explanation, repaired and completed. Plain markdown, intuition-first, " +
        "no preamble like 'Here is'.",
    ),
});

export type CritiqueSchema = z.infer<typeof critiqueSchema>;

// --- prompts --------------------------------------------------------------

/**
 * System prompt: the Feynman rubric. We are critiquing an EXPLANATION the
 * learner wrote to teach the idea back — not grading an answer to a question.
 */
export function critiqueSystemPrompt(): string {
  return [
    "You are a warm but rigorous tutor running a Feynman 'explain it back' exercise.",
    "The learner has tried to TEACH a concept back in their own words. Critique their",
    "EXPLANATION itself — it is not an answer to a question. Judge how well it would",
    "teach the idea to someone else.",
    "Be kind but honest: never inflate, never give empty praise. A false 'you've got it'",
    "leaves a gap the learner can't see. Reward exactly what is right, name exactly what",
    "is missing, wrong, vague, or muddled.",
    "Assess three things together: correctness (is what they said true?), completeness",
    "(are the key ideas present?), and clarity (would it actually teach someone?).",
    "Scoring:",
    "  - score (0..1): the fraction of the concept's key ideas the explanation gets",
    "    right AND conveys clearly. A correct-but-thin explanation scores in the middle;",
    "    confident wrong claims score low.",
    "Always end with refinedExplanation: a tight, correct re-explanation built FROM the",
    "learner's own words — repaired and completed — short enough to re-read and study.",
    "Grade ONLY against the supplied concept notes as ground truth. Address the learner",
    "directly as 'you'.",
  ].join("\n");
}

/**
 * User prompt: the concept notes (ground truth) plus the learner's explanation.
 */
export function critiqueUserPrompt(args: {
  title: string;
  subject: string;
  bodyMarkdown: string;
  explanation: string;
}): string {
  return [
    `Concept the learner is explaining: "${args.title}" (subject: ${args.subject}).`,
    "",
    "Ground-truth notes for this concept:",
    "---",
    args.bodyMarkdown.trim() ||
      "(no notes provided — judge against the concept title and subject)",
    "---",
    "",
    "The learner's own explanation:",
    "---",
    args.explanation.trim() || "(blank)",
    "---",
    "",
    "Critique their explanation now.",
  ].join("\n");
}
