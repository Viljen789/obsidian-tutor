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
import { defineSecret } from "firebase-functions/params";
import { z, type ZodType } from "zod";
import type { CompleteArgs } from "./anthropic";

export const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

const useVertex = process.env.LLM_PROVIDER === "gemini-vertex";

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) {
    client = useVertex
      ? new GoogleGenAI({
          vertexai: true,
          project: process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT,
          location: process.env.VERTEX_LOCATION ?? "us-central1",
        })
      : new GoogleGenAI({ apiKey: GEMINI_API_KEY.value() });
  }
  return client;
}

export async function completeText(args: CompleteArgs): Promise<string> {
  const res = await getClient().models.generateContent({
    model: args.model,
    contents: args.prompt,
    config: {
      systemInstruction: args.system,
      maxOutputTokens: args.maxTokens,
    },
  });
  return (res.text ?? "").trim();
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

  const res = await getClient().models.generateContent({
    model: args.model,
    contents: prompt,
    config: {
      systemInstruction: args.system,
      maxOutputTokens: args.maxTokens,
      responseMimeType: "application/json",
    },
  });

  const text = res.text;
  if (!text) throw new Error("Gemini returned no structured output.");
  // Be tolerant of accidental ```json fences before validating.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return args.schema.parse(JSON.parse(cleaned));
}
