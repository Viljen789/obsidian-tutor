/**
 * submitAnswer flow — the core of the teach->grade->update loop.
 *
 * Composes AI grading (Phase 2) with the pure mastery update (Phase 3) and
 * persists the new learner state, returning both the feedback and the updated
 * mastery. This MUST stay server-side — grading and SM-2 are never
 * client-trusted.
 *
 * NOTE: the engine (applyGrade/newMastery) is implemented in parallel and
 * currently throws "not implemented" — that is expected. This flow is wired to
 * the contract; the orchestrator verifies the full loop live in Phase 5.
 */
import type { SubmitAnswerRequest, SubmitAnswerResponse } from "@tutor/shared";
import { authedCallable, HttpsError } from "../lib/callable";
import { llmSecrets } from "../lib/llm";
import { getConcept, getMastery, getSettings, setMastery } from "../lib/firebase";
import { gradeAnswer } from "../ai/index";
import { applyGrade, newMastery } from "../engine/index";

export const submitAnswer = authedCallable<SubmitAnswerRequest, SubmitAnswerResponse>(
  { secrets: llmSecrets },
  async (data, { uid }): Promise<SubmitAnswerResponse> => {
    const concept = await getConcept(uid, data.conceptId);
    if (!concept) {
      throw new HttpsError("not-found", `Concept not found: ${data.conceptId}`);
    }

    // Grade the free-text answer against the concept notes (server-side).
    const grade = await gradeAnswer({
      question: data.question,
      answer: data.answer,
      conceptTitle: concept.title,
      conceptContext: concept.bodyMarkdown,
    });

    // Load existing learner state (or start fresh) and the learner's settings —
    // the masteredThreshold knob must drive when a concept counts as "mastered".
    const current = (await getMastery(uid, data.conceptId)) ?? newMastery(data.conceptId);
    const settings = await getSettings(uid);

    // No-peek integrity: if the learner revealed the material before answering,
    // cap the grade — a peeked recall is a weaker memory. The cap flows into FSRS
    // as a lower quality → a shorter interval, which is the correct outcome.
    const effective = data.peeked
      ? {
          ...grade,
          quality: Math.min(grade.quality, 3),
          score: grade.score * 0.6,
          feedback:
            grade.feedback +
            " (Score capped — you revealed the material; answer from memory next time for full credit.)",
        }
      : grade;

    // Advance SM-2 + mastery deterministically (time injected, engine stays pure).
    const mastery = applyGrade(
      current,
      effective.quality,
      effective.score,
      Date.now(),
      settings.masteredThreshold,
    );

    await setMastery(uid, mastery);

    return { grade: effective, mastery };
  },
);
