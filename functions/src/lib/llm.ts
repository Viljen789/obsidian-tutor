/**
 * Provider switch. The whole backend imports its LLM helpers, model ids, and
 * secret bindings from HERE — so changing providers is one env var (`LLM_PROVIDER`),
 * no code edits:
 *
 *   gemini         (default)  Google AI Studio, free Flash — set GEMINI_API_KEY
 *   gemini-vertex            Vertex AI (uses the $300 credit, no key — service account)
 *   anthropic                Claude — set ANTHROPIC_API_KEY
 *
 * Only the active provider's secret is bound to the callables, so deploying with
 * just one key set never trips "secret not found".
 */
import { defineSecret } from "firebase-functions/params";
import { MODEL_SETS } from "../config";
import * as anthropic from "./anthropic";
import * as gemini from "./gemini";

export type Provider = "gemini" | "gemini-vertex" | "anthropic";

export const PROVIDER: Provider =
  (process.env.LLM_PROVIDER as Provider) || "gemini";

const isGemini = PROVIDER !== "anthropic";

/** Model ids for the active provider (see config.ts → MODEL_SETS). */
export const MODELS = isGemini ? MODEL_SETS.gemini : MODEL_SETS.anthropic;

/**
 * Declare + bind ONLY the active provider's secret. Declaring a secret makes the
 * deploy demand a value for it, so declaring both would force users to set an
 * Anthropic key just to run Gemini. Vertex uses the service account (no secret).
 */
const activeSecret =
  PROVIDER === "anthropic"
    ? defineSecret("ANTHROPIC_API_KEY")
    : PROVIDER === "gemini"
      ? defineSecret("GEMINI_API_KEY")
      : null;

/** Secret(s) to bind on AI callables. */
export const llmSecrets = activeSecret ? [activeSecret] : [];

export const completeText: typeof anthropic.completeText = isGemini
  ? gemini.completeText
  : anthropic.completeText;

export const completeStructured: typeof anthropic.completeStructured = isGemini
  ? gemini.completeStructured
  : anthropic.completeStructured;
