/**
 * Central AI + cost configuration. To swap models, edit ONLY this file; to swap
 * PROVIDERS, set the LLM_PROVIDER env var (see lib/llm.ts).
 *
 * Per provider:
 *   - teach/grade: the stronger model — intuition-first explanations, fair grading.
 *   - classify:    the cheap/fast model — prerequisite inference, light classification.
 *
 * Gemini defaults to free-tier Flash. Bump `teach`/`grade` to "gemini-2.5-pro"
 * (or "gemini-3.5-flash") for higher quality — free-tier on AI Studio, or covered
 * by the $300 credit on Vertex.
 */
export const MODEL_SETS = {
  gemini: {
    teach: "gemini-2.5-flash",
    grade: "gemini-2.5-flash",
    classify: "gemini-2.5-flash-lite",
  },
  anthropic: {
    teach: "claude-sonnet-4-6",
    grade: "claude-sonnet-4-6",
    classify: "claude-haiku-4-5",
  },
} as const;

/** Hard output-token caps per call — a cost/latency guardrail (see §7). */
export const TOKEN_CAPS = {
  explain: 1600,
  questions: 900,
  grade: 800,
  hint: 250,
  classify: 256,
} as const;

export const DEFAULTS = {
  questionCount: 3,
  region: "us-central1",
  maxInstances: 10,
} as const;
