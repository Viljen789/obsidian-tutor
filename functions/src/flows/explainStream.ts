/**
 * explainConceptStream — a STREAMING sibling of explainConcept.
 *
 * Uses Firebase's streaming callables: the handler's second arg `response` lets
 * us `sendChunk` partial text as the model produces it, so the UI can render the
 * explanation progressively. The final return value is what a non-streaming
 * caller (or `.stream().data`) receives — identical shape to explainConcept, so
 * the client can fall back to the plain callable transparently.
 *
 * Same cost guardrail as explainConcept: serve from explanationCache on a hit
 * (one chunk), and cache the streamed result on a miss. Auth is enforced inline
 * (this is a raw onCall, not the authedCallable wrapper, so it can stream).
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import type {
  ExplainConceptRequest,
  ExplainConceptResponse,
  ExplanationCacheEntry,
} from "@tutor/shared";
import { TOKEN_CAPS } from "../config";
import { MODELS, streamText, llmSecrets } from "../lib/llm";
import { getConcept, getExplanationCache, setExplanationCache } from "../lib/firebase";
import { explainSystemPrompt, explainUserPrompt } from "../ai/prompts";

export const explainConceptStream = onCall(
  { secrets: llmSecrets },
  async (request, response): Promise<ExplainConceptResponse> => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "You must be signed in.");

    const data = (request.data ?? {}) as ExplainConceptRequest;
    if (!data.conceptId) {
      throw new HttpsError("invalid-argument", "conceptId is required.");
    }
    const depth = data.depth ?? "standard";

    const concept = await getConcept(uid, data.conceptId);
    if (!concept) {
      throw new HttpsError("not-found", `Concept not found: ${data.conceptId}`);
    }

    // Cost guardrail: a cached explanation streams as a single chunk.
    const cached = await getExplanationCache(uid, data.conceptId, depth);
    if (cached) {
      response?.sendChunk({ text: cached.markdown });
      return {
        conceptId: data.conceptId,
        depth,
        markdown: cached.markdown,
        model: cached.model,
        cached: true,
      };
    }

    let full = "";
    for await (const piece of streamText({
      model: MODELS.teach,
      system: explainSystemPrompt(depth),
      prompt: explainUserPrompt({
        title: concept.title,
        subject: concept.subject,
        bodyMarkdown: concept.bodyMarkdown,
      }),
      maxTokens: TOKEN_CAPS.explain,
    })) {
      full += piece;
      response?.sendChunk({ text: piece });
    }

    const markdown = full.trim();
    const entry: ExplanationCacheEntry = {
      conceptId: data.conceptId,
      depth,
      markdown,
      model: MODELS.teach,
      createdAt: new Date().toISOString(),
    };
    await setExplanationCache(uid, entry);

    return { conceptId: data.conceptId, depth, markdown, model: MODELS.teach, cached: false };
  },
);
