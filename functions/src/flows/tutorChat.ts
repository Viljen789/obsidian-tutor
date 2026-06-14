/**
 * tutorChat flow — ask-a-follow-up.
 *
 * A stateless tutor turn grounded in one concept's notes. The client owns the
 * running transcript (session-local) and re-sends it each turn; this callable
 * persists nothing. We validate the transcript, load the concept for grounding,
 * build a patient intuition-first prompt, and return the model's reply.
 */
import type { TutorChatRequest, TutorChatResponse } from "@tutor/shared";
import { chatSystemPrompt, chatUserPrompt } from "../ai/chatPrompts";
import { TOKEN_CAPS } from "../config";
import { authedCallable, HttpsError } from "../lib/callable";
import { getConcept } from "../lib/firebase";
import { MODELS, completeText, llmSecrets } from "../lib/llm";

export const tutorChat = authedCallable<TutorChatRequest, TutorChatResponse>(
  { secrets: llmSecrets },
  async (data, { uid }): Promise<TutorChatResponse> => {
    // The transcript must end on the learner's new question — there's nothing to
    // answer otherwise.
    const messages = data.messages ?? [];
    const last = messages[messages.length - 1];
    if (messages.length === 0 || !last || last.role !== "user") {
      throw new HttpsError(
        "invalid-argument",
        "messages must be non-empty and end with a user message.",
      );
    }

    const concept = await getConcept(uid, data.conceptId);
    if (!concept) {
      throw new HttpsError("not-found", `Concept not found: ${data.conceptId}`);
    }

    const reply = await completeText({
      model: MODELS.teach,
      system: chatSystemPrompt(),
      prompt: chatUserPrompt({
        title: concept.title,
        subject: concept.subject,
        bodyMarkdown: concept.bodyMarkdown,
        messages,
      }),
      maxTokens: TOKEN_CAPS.chat,
    });

    return { reply, model: MODELS.teach };
  },
);
