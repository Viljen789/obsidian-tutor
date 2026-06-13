/**
 * The single place the Anthropic SDK is touched. Phase 2 writes prompts and Zod
 * schemas and calls these helpers — it should not construct the client or call
 * `messages.*` directly. The API key is a Secret Manager secret, bound to each
 * AI callable via `secrets: [ANTHROPIC_API_KEY]`.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";

// The key arrives as an env var when its secret is bound to the function
// (lib/llm.ts declares + binds only the active provider's secret).
let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export interface CompleteArgs {
  model: string;
  /** System prompt — the stable instruction/persona. */
  system: string;
  /** The user turn (concept text, question + answer, etc.). */
  prompt: string;
  maxTokens: number;
}

/** Plain-text completion. Returns the concatenated text blocks. */
export async function completeText(args: CompleteArgs): Promise<string> {
  const res = await getClient().messages.create({
    model: args.model,
    max_tokens: args.maxTokens,
    system: args.system,
    messages: [{ role: "user", content: args.prompt }],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/**
 * Structured completion. Constrains the model to `schema` and returns the
 * validated object — no hand-parsing, no "model forgot a field" bugs. Supported
 * on the models in config.ts (Sonnet 4.6 / Haiku 4.5).
 */
export async function completeStructured<T>(
  args: CompleteArgs & { schema: ZodType<T> },
): Promise<T> {
  const res = await getClient().messages.parse({
    model: args.model,
    max_tokens: args.maxTokens,
    system: args.system,
    messages: [{ role: "user", content: args.prompt }],
    output_config: { format: zodOutputFormat(args.schema) },
  });
  if (!res.parsed_output) {
    throw new Error("Anthropic returned no parseable structured output.");
  }
  return res.parsed_output;
}
