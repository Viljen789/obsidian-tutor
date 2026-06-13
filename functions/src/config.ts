/**
 * Central AI + cost configuration. To swap models, edit ONLY this file.
 *
 * Model ids (current Claude family):
 *   - teach/grade: a strong Sonnet — intuition-first explanations, fair grading.
 *   - classify:    a cheap Haiku   — prerequisite inference, light classification.
 */
export const MODELS = {
  teach: "claude-sonnet-4-6",
  grade: "claude-sonnet-4-6",
  classify: "claude-haiku-4-5",
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
