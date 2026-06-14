/**
 * generateFlashcards flow — build a per-concept recall deck.
 *
 * A deck is two kinds of card stitched together:
 *   - CLOZE  — instant, note-derived fill-in-the-blank cards (cloze.ts). Pure,
 *              zero model calls, derived from the concept's own bolded terms.
 *   - Q/A    — a few model-written question/answer cards that test the recall
 *              and understanding the cloze blanks can't reach.
 *
 * Decks are cached per concept (getFlashcardDeck/setFlashcardDeck) exactly like
 * explanationCache — a cost guardrail so repeat drills never re-spend a call.
 *
 * Resilience: the cloze half is the floor. If the model call for the Q/A half
 * fails (rate limit, bad JSON, timeout), we DEGRADE GRACEFULLY to a cloze-only
 * deck rather than failing the whole request — the learner always gets cards.
 */
import type {
  Flashcard,
  FlashcardDeck,
  GenerateFlashcardsRequest,
  GenerateFlashcardsResponse,
} from "@tutor/shared";
import { DEFAULTS, TOKEN_CAPS } from "../config";
import { authedCallable, HttpsError } from "../lib/callable";
import { MODELS, completeStructured, llmSecrets } from "../lib/llm";
import { getConcept, getFlashcardDeck, setFlashcardDeck } from "../lib/firebase";
import { flashcardsSystemPrompt, flashcardsUserPrompt } from "../ai/flashcardPrompts";
import { generatedFlashcardsSchema } from "../ai/flashcardSchemas";
import { extractClozeCards } from "./cloze";

/** Sensible bounds on the requested deck size — a tiny deck is pointless, a huge one wastes tokens. */
const MIN_COUNT = 2;
const MAX_COUNT = 20;

/** Clamp the requested count into [MIN_COUNT, MAX_COUNT]; fall back to the default for junk input. */
function clampCount(requested: number | undefined): number {
  const n = Number(requested ?? DEFAULTS.flashcardCount);
  if (!Number.isFinite(n)) return DEFAULTS.flashcardCount;
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(n)));
}

export const generateFlashcards = authedCallable<
  GenerateFlashcardsRequest,
  GenerateFlashcardsResponse
>({ secrets: llmSecrets }, async (data, { uid }): Promise<GenerateFlashcardsResponse> => {
  const count = clampCount(data.count);

  // 1. The concept must exist before we build anything.
  const concept = await getConcept(uid, data.conceptId);
  if (!concept) {
    throw new HttpsError("not-found", `Concept not found: ${data.conceptId}`);
  }

  // 2. Cost guardrail: serve a cached deck before deriving cards or calling the model.
  const cached = await getFlashcardDeck(uid, data.conceptId);
  if (cached) {
    return {
      conceptId: data.conceptId,
      cards: cached.cards,
      model: cached.model,
      cached: true,
    };
  }

  // 3. Cloze half (instant, no model call). Target ~half the deck, at least one.
  const clozeTarget = Math.max(1, Math.floor(count / 2));
  const clozeCards = extractClozeCards(data.conceptId, concept.bodyMarkdown, clozeTarget);

  // 4. Q/A half — fill the rest of the deck with model-written cards. Ask for
  //    whatever the cloze half didn't cover (so a body with few bold terms still
  //    reaches `count`). DEGRADE GRACEFULLY: any failure → cloze-only deck.
  const qaTarget = Math.max(0, count - clozeCards.length);
  let qaCards: Flashcard[] = [];

  if (qaTarget > 0) {
    try {
      const result = await completeStructured({
        model: MODELS.teach,
        system: flashcardsSystemPrompt(qaTarget),
        prompt: flashcardsUserPrompt({
          title: concept.title,
          subject: concept.subject,
          bodyMarkdown: concept.bodyMarkdown,
          count: qaTarget,
        }),
        maxTokens: TOKEN_CAPS.flashcards,
        schema: generatedFlashcardsSchema,
      });

      // Structured output can't enforce array length, so clamp it here, and
      // assign stable ids / conceptId / kind server-side (never trust the model).
      qaCards = result.cards.slice(0, qaTarget).map((c, i) => ({
        id: `${data.conceptId}_fc_qa_${i + 1}`,
        conceptId: data.conceptId,
        kind: "qa" as const,
        front: c.front,
        back: c.back,
        ...(c.hint ? { hint: c.hint } : {}),
      }));
    } catch (err) {
      // The cloze cards are the floor — a model hiccup must not fail the request.
      console.error(`generateFlashcards: Q/A generation failed for ${data.conceptId}`, err);
      qaCards = [];
    }
  }

  // 5. Assemble, cache, and return. `model` is "" for a purely note-derived deck
  //    (no qa cards) so the client can tell whether a model was involved.
  const cards = [...clozeCards, ...qaCards];
  const anyQa = qaCards.length > 0;
  const model = anyQa ? MODELS.teach : "";

  const deck: FlashcardDeck = {
    conceptId: data.conceptId,
    cards,
    model,
    createdAt: new Date().toISOString(),
  };
  await setFlashcardDeck(uid, deck);

  return { conceptId: data.conceptId, cards, model, cached: false };
});
