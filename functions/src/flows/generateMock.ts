/**
 * generateMock — past-exam → mock generator. The learner pastes a past paper's
 * questions; we produce a FRESH set in the same style + difficulty, spread across
 * the subject's own concepts, each carrying a real conceptId so it grades through
 * submitAnswer (a mock doubles as graded review).
 *
 * Shape mirrors flows/generateExam.ts: load the subject's concepts, make ONE
 * structured LLM call, then own the id + conceptId assignment server-side so the
 * model can fabricate neither. The difference: we seed the prompt with
 * `pastExamText` as a STYLE reference, with a hard guardrail against copying any
 * pasted question verbatim/near-verbatim (see ai/mockPrompts.ts).
 *
 * The model proposes `{ conceptRef, type, prompt }` per question — `conceptRef`
 * is a 1-based index into the numbered concept list. We clamp it into range and
 * fall back to round-robin across concepts when it's missing or invalid, so a
 * mock never ships a question without a valid conceptId.
 */
import type {
  Concept,
  GenerateMockRequest,
  GenerateMockResponse,
  Question,
} from "@tutor/shared";
import { TOKEN_CAPS } from "../config";
import { authedCallable, HttpsError } from "../lib/callable";
import { MODELS, completeStructured, llmSecrets } from "../lib/llm";
import { listConcepts } from "../lib/firebase";
import { mockSchema, mockSystemPrompt, mockUserPrompt } from "../ai/mockPrompts";

/** Minimum pasted text we'll treat as a real past paper to mimic. */
const MIN_PAST_EXAM_CHARS = 20;
/** Clamp on the question count so a huge `count` can't blow the token budget. */
const MIN_MOCK_COUNT = 3;
const MAX_MOCK_COUNT = 20;
/** A mock is longer than a single-concept set; lean toward an exam-sized default. */
const DEFAULT_MOCK_COUNT = 10;

export const generateMock = authedCallable<GenerateMockRequest, GenerateMockResponse>(
  { secrets: llmSecrets },
  async (data, { uid }): Promise<GenerateMockResponse> => {
    const subject = (data.subject ?? "").trim();
    if (!subject) {
      throw new HttpsError("invalid-argument", "A mock exam needs a subject.");
    }

    const pastExamText = (data.pastExamText ?? "").trim();
    if (pastExamText.length < MIN_PAST_EXAM_CHARS) {
      throw new HttpsError(
        "invalid-argument",
        "Paste a past exam's questions (a few lines at least) to generate a mock in its style.",
      );
    }

    const concepts = await listConcepts(uid, subject);
    if (concepts.length === 0) {
      throw new HttpsError(
        "not-found",
        `No concepts in "${subject}". Import a vault with this subject first.`,
      );
    }

    // Clamp the requested count into a sane range; `Math.floor` guards a fractional
    // `count`, and the [MIN, MAX] window keeps the JSON within its token budget.
    const requested = data.count ?? DEFAULT_MOCK_COUNT;
    const count = Math.max(MIN_MOCK_COUNT, Math.min(MAX_MOCK_COUNT, Math.floor(requested)));

    const system = mockSystemPrompt(subject, count);
    const prompt = mockUserPrompt({ subject, concepts, pastExamText, count });

    const result = await completeStructured({
      model: MODELS.teach,
      system,
      prompt,
      maxTokens: TOKEN_CAPS.mock,
      schema: mockSchema,
    });

    // Map each generated question to a real conceptId. We trust the model's
    // `conceptRef` only as a hint: round + convert to 0-based, and accept it only
    // if it indexes a real concept. Otherwise (missing/out-of-range, or the model
    // returned fewer questions than asked) fall back to round-robin so the mock is
    // still spread across concepts and every question has a valid conceptId.
    const questions: Question[] = [];
    const target = Math.min(count, result.questions.length || count);
    for (let i = 0; i < target; i++) {
      const generated = result.questions[i];
      const fallback = concepts[i % concepts.length] as Concept; // concepts is non-empty
      const ref = generated ? Math.round(generated.conceptRef) - 1 : -1;
      const concept =
        ref >= 0 && ref < concepts.length ? (concepts[ref] as Concept) : fallback;

      const promptText = generated?.prompt?.trim();
      questions.push({
        id: `${subject}_mock_${i + 1}`,
        conceptId: concept.id,
        type: generated?.type ?? "recall",
        prompt: promptText || `Answer an exam-style question on "${concept.title}".`,
      });
    }

    return { subject, questions, model: MODELS.teach };
  },
);
