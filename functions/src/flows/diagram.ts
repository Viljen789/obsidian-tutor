/**
 * generateDiagram flow.
 *
 * Produces ONE valid Mermaid diagram for a concept (the model picks flowchart /
 * ER / state / sequence / class — whatever fits), grounded in the concept's
 * notes, and renders client-side (DiagramPanel). Like explanationCache, it caches
 * one diagram per concept so a re-open never re-spends a model call.
 *
 * Flow (mirrors explainConcept):
 *   1. Load the concept (404 if missing).
 *   2. Cost guardrail: serve from `getDiagram` cache before spending a call.
 *   3. `completeText` (MODELS.teach, TOKEN_CAPS.diagram) for RAW Mermaid source,
 *      then strip any ```mermaid / ``` fence Gemini may wrap it in so the stored
 *      string is pure Mermaid the renderer can parse.
 *   4. Cache via `setDiagram` and return.
 */
import type {
  DiagramEntry,
  GenerateDiagramRequest,
  GenerateDiagramResponse,
} from "@tutor/shared";
import { TOKEN_CAPS } from "../config";
import { authedCallable, HttpsError } from "../lib/callable";
import { MODELS, completeText, llmSecrets } from "../lib/llm";
import { getConcept, getDiagram, setDiagram } from "../lib/firebase";
import { diagramSystemPrompt, diagramUserPrompt } from "../ai/diagramPrompts";

/**
 * Strip a wrapping Markdown code fence from a model's "raw Mermaid" output.
 * Gemini frequently ignores "no fences" and returns ```mermaid … ``` (or a bare
 * ``` … ```), which Mermaid's parser cannot read. We peel exactly one leading
 * fence (optionally tagged `mermaid`/`mmd`) and one trailing fence, leaving any
 * inner backticks untouched, so the cached string is pure Mermaid source.
 */
export function stripMermaidFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:mermaid|mmd)?[ \t]*\r?\n?/i, "")
    .replace(/\r?\n?```[ \t]*$/i, "")
    .trim();
}

export const generateDiagram = authedCallable<
  GenerateDiagramRequest,
  GenerateDiagramResponse
>({ secrets: llmSecrets }, async (data, { uid }): Promise<GenerateDiagramResponse> => {
  const concept = await getConcept(uid, data.conceptId);
  if (!concept) {
    throw new HttpsError("not-found", `Concept not found: ${data.conceptId}`);
  }

  // Cost guardrail: serve from cache before spending a model call.
  const cached = await getDiagram(uid, data.conceptId);
  if (cached) {
    return {
      conceptId: data.conceptId,
      mermaid: cached.mermaid,
      model: cached.model,
      cached: true,
    };
  }

  const raw = await completeText({
    model: MODELS.teach,
    system: diagramSystemPrompt(),
    prompt: diagramUserPrompt({
      title: concept.title,
      subject: concept.subject,
      bodyMarkdown: concept.bodyMarkdown,
    }),
    maxTokens: TOKEN_CAPS.diagram,
  });

  const mermaid = stripMermaidFence(raw);

  const entry: DiagramEntry = {
    conceptId: data.conceptId,
    mermaid,
    model: MODELS.teach,
    createdAt: new Date().toISOString(),
  };
  await setDiagram(uid, entry);

  return {
    conceptId: data.conceptId,
    mermaid,
    model: MODELS.teach,
    cached: false,
  };
});
