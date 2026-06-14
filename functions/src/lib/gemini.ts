/**
 * Gemini provider — mirrors lib/anthropic's interface (completeText /
 * completeStructured) so the rest of the backend is provider-agnostic.
 *
 * Two backends, chosen by LLM_PROVIDER:
 *   - "gemini"        → Google AI Studio (free tier), authenticated with an API key.
 *   - "gemini-vertex" → Vertex AI on Google Cloud, authenticated with the
 *                        function's own service account (NO key) — and covered by
 *                        the $300 Google Cloud trial credit.
 *
 * Structured output uses responseMimeType: "application/json" plus a schema hint
 * in the prompt, then validates the result with the same Zod schema the rest of
 * the code already declares — so callers get a typed, validated object either way.
 */
import { GoogleGenAI } from "@google/genai";
import { z, type ZodType } from "zod";
import type { CompleteArgs } from "./anthropic";

const useVertex = process.env.LLM_PROVIDER === "gemini-vertex";

// The key arrives as an env var when GEMINI_API_KEY is bound to the function
// (lib/llm.ts). Vertex needs no key — it uses the function's service account.
let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) {
    client = useVertex
      ? new GoogleGenAI({
          vertexai: true,
          project: process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT,
          location: process.env.VERTEX_LOCATION ?? "us-central1",
        })
      : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

/** True for transient Gemini errors worth retrying (free-tier 429s, 5xx). */
function isRetriableError(err: unknown): boolean {
  const e = err as { status?: number; code?: number; message?: string } | undefined;
  const status = e?.status ?? e?.code;
  if (status === 429 || status === 500 || status === 503) return true;
  const msg = String(e?.message ?? err ?? "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("resource_exhausted") ||
    msg.includes("rate limit") ||
    msg.includes("503") ||
    msg.includes("unavailable") ||
    msg.includes("overloaded")
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run a Gemini call with jittered exponential backoff. The free tier returns
 * 429 (RESOURCE_EXHAUSTED) under light load plus the occasional 5xx; a few
 * retries ride those out so interactive features (chat, grading, explanations)
 * don't fail on a transient blip.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 4;
  let delayMs = 600;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isRetriableError(err)) throw err;
      await sleep(delayMs + Math.floor(Math.random() * 300));
      delayMs *= 2;
    }
  }
}

export async function completeText(args: CompleteArgs): Promise<string> {
  const res = await withRetry(() =>
    getClient().models.generateContent({
      model: args.model,
      contents: args.prompt,
      config: {
        systemInstruction: args.system,
        maxOutputTokens: args.maxTokens,
        // Disable Flash's "thinking" — it would consume the output-token budget.
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  );
  return (res.text ?? "").trim();
}

/**
 * Streaming plain-text completion — yields incremental text pieces as the model
 * produces them (for progressive UI render). Same config as completeText
 * (thinking disabled). The initial request is retried on transient errors; once
 * the stream is open, pieces flow until done.
 */
export async function* streamText(args: CompleteArgs): AsyncGenerator<string> {
  const stream = await withRetry(() =>
    getClient().models.generateContentStream({
      model: args.model,
      contents: args.prompt,
      config: {
        systemInstruction: args.system,
        maxOutputTokens: args.maxTokens,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  );
  for await (const chunk of stream) {
    const piece = chunk.text;
    if (piece) yield piece;
  }
}

/** JSON Schema for the prompt hint, minus keys Gemini's parser dislikes. */
function schemaHint(schema: ZodType<unknown>): string {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "$schema" || k === "additionalProperties") continue;
        out[k] = strip(v);
      }
      return out;
    }
    return node;
  };
  return JSON.stringify(strip(json));
}

export async function completeStructured<T>(
  args: CompleteArgs & { schema: ZodType<T> },
): Promise<T> {
  const prompt =
    `${args.prompt}\n\nReturn ONLY a JSON object matching this schema ` +
    `(no markdown fences, no commentary):\n${schemaHint(args.schema)}`;

  const res = await withRetry(() =>
    getClient().models.generateContent({
      model: args.model,
      contents: prompt,
      config: {
        systemInstruction: args.system,
        maxOutputTokens: args.maxTokens,
        responseMimeType: "application/json",
        // Disable Flash's "thinking" — otherwise it eats the output budget and
        // the JSON gets truncated mid-string ("Unterminated string in JSON").
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  );

  const text = res.text;
  if (!text) throw new Error("Gemini returned no structured output.");
  // Be tolerant of accidental ```json fences before validating.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return args.schema.parse(JSON.parse(cleaned));
}
