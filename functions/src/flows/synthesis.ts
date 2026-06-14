/**
 * synthesis flows — cross-concept "integration" questions.
 *
 * generateSynthesis: exam-style questions that each weave >= 2 of a subject's
 * concepts together. Shape mirrors flows/generateMock.ts: load the subject's
 * concepts, make ONE structured LLM call (MODELS.teach, TOKEN_CAPS.synthesis),
 * then own the conceptId + stable-id assignment server-side so the model can
 * fabricate neither. The model proposes `{ conceptRefs, type, prompt }` per
 * question, where each `conceptRefs` entry is a 1-based index into the numbered
 * concept list. We clamp/de-dupe/validate those refs and fall back to pairing
 * adjacent concepts, so a synthesis question NEVER ships with fewer than two
 * valid distinct conceptIds.
 *
 * gradeSynthesis: grade a free-text answer against the COMBINED context of ALL
 * the question's conceptIds (each concept's title + body, concatenated), then
 * advance EVERY involved concept's mastery (the learner practised them all):
 * for each, load its mastery (or mint fresh), applyGrade with the same quality/
 * score + settings.masteredThreshold, and persist. Returns { grade }.
 */
import type {
  Concept,
  GenerateSynthesisRequest,
  GenerateSynthesisResponse,
  GradeSynthesisRequest,
  GradeSynthesisResponse,
  Mastery,
  SynthesisQuestion,
} from "@tutor/shared";
import { TOKEN_CAPS } from "../config";
import { authedCallable, HttpsError } from "../lib/callable";
import { MODELS, completeStructured, llmSecrets } from "../lib/llm";
import {
  getConcept,
  getMastery,
  getSettings,
  listConcepts,
  setMastery,
} from "../lib/firebase";
import { applyGrade, newMastery } from "../engine/index";
import { gradeAnswer } from "../ai/index";
import {
  synthesisSchema,
  synthesisSystemPrompt,
  synthesisUserPrompt,
} from "../ai/synthesisPrompts";

/** Clamp on the question count so a huge `count` can't blow the token budget. */
const MIN_SYNTHESIS_COUNT = 3;
const MAX_SYNTHESIS_COUNT = 12;
const DEFAULT_SYNTHESIS_COUNT = 6;
/** A synthesis question integrates at least this many concepts. */
const MIN_CONCEPTS_PER_QUESTION = 2;
/** Cap the joined ground-truth context so grading stays inside its token budget. */
const GRADE_CONTEXT_CHARS = 1800;

export const generateSynthesis = authedCallable<
  GenerateSynthesisRequest,
  GenerateSynthesisResponse
>({ secrets: llmSecrets }, async (data, { uid }): Promise<GenerateSynthesisResponse> => {
  const subject = (data.subject ?? "").trim();
  if (!subject) {
    throw new HttpsError("invalid-argument", "A synthesis set needs a subject.");
  }

  const concepts = await listConcepts(uid, subject);
  if (concepts.length < MIN_CONCEPTS_PER_QUESTION) {
    throw new HttpsError(
      "failed-precondition",
      "Synthesis needs at least two concepts in a subject.",
    );
  }

  // Clamp the requested count into a sane window; `Math.floor` guards a fractional
  // `count`, and [MIN, MAX] keeps the returned JSON within its token budget.
  const requested = data.count ?? DEFAULT_SYNTHESIS_COUNT;
  const count = Math.max(
    MIN_SYNTHESIS_COUNT,
    Math.min(MAX_SYNTHESIS_COUNT, Math.floor(requested)),
  );

  const system = synthesisSystemPrompt(subject, count);
  const prompt = synthesisUserPrompt({ subject, concepts, count });

  const result = await completeStructured({
    model: MODELS.teach,
    system,
    prompt,
    maxTokens: TOKEN_CAPS.synthesis,
    schema: synthesisSchema,
  });

  // Map each generated question's `conceptRefs` (1-based) to real, distinct
  // conceptIds. We trust the refs only as hints: round + convert to 0-based,
  // keep only those that index a real concept, and de-dupe. A question that ends
  // up with < 2 valid concepts (missing/garbage refs, or the model returned
  // fewer questions than asked) falls back to a pair of ADJACENT concepts, so
  // every shipped question genuinely integrates at least two concepts.
  const questions: SynthesisQuestion[] = [];
  const target = Math.min(count, result.questions.length || count);
  for (let i = 0; i < target; i++) {
    const generated = result.questions[i];

    const seen = new Set<string>();
    const conceptIds: string[] = [];
    for (const ref of generated?.conceptRefs ?? []) {
      const idx = Math.round(ref) - 1;
      if (idx < 0 || idx >= concepts.length) continue; // out of range — drop it
      const concept = concepts[idx] as Concept;
      if (seen.has(concept.id)) continue; // de-dupe repeated refs
      seen.add(concept.id);
      conceptIds.push(concept.id);
    }

    // Fallback: pair two adjacent concepts (wrapping at the end) when the model
    // gave us too few valid, distinct refs to make a real synthesis question.
    if (conceptIds.length < MIN_CONCEPTS_PER_QUESTION) {
      const a = concepts[i % concepts.length] as Concept;
      const b = concepts[(i + 1) % concepts.length] as Concept;
      conceptIds.length = 0;
      conceptIds.push(a.id);
      if (b.id !== a.id) conceptIds.push(b.id);
    }

    const promptText = generated?.prompt?.trim();
    const titles = conceptIds
      .map((id) => concepts.find((c) => c.id === id)?.title)
      .filter((t): t is string => !!t);
    questions.push({
      id: `${subject}_syn_${i + 1}`,
      type: generated?.type ?? "application",
      prompt:
        promptText ||
        `Connect these concepts in one answer: ${titles.join(" and ")}.`,
      conceptIds,
    });
  }

  return { subject, questions, model: MODELS.teach };
});

export const gradeSynthesis = authedCallable<GradeSynthesisRequest, GradeSynthesisResponse>(
  { secrets: llmSecrets },
  async (data, { uid }): Promise<GradeSynthesisResponse> => {
    const question = (data.question ?? "").trim();
    const answer = (data.answer ?? "").trim();
    if (!question) {
      throw new HttpsError("invalid-argument", "A synthesis question is required to grade.");
    }
    if (!answer) {
      throw new HttpsError("invalid-argument", "Write an answer before submitting it for grading.");
    }

    // De-dupe the incoming ids, then load each concept. We grade against the
    // COMBINED context of every concept the question integrates.
    const conceptIds = [...new Set((data.conceptIds ?? []).filter((id) => !!id))];
    if (conceptIds.length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "A synthesis answer must be tied to at least one concept.",
      );
    }

    const loaded = await Promise.all(conceptIds.map((id) => getConcept(uid, id)));
    const concepts = loaded.filter((c): c is Concept => c != null);
    if (concepts.length === 0) {
      throw new HttpsError("not-found", "None of the referenced concepts were found.");
    }

    // Build the combined ground truth: a joined title (so the grader knows which
    // concepts to weigh) and each concept's body, fenced by title, concatenated.
    const conceptTitle = concepts.map((c) => c.title).join(" + ");
    const conceptContext = concepts
      .map((c) => {
        const body = c.bodyMarkdown.trim() || "(no additional notes — use the concept title)";
        return `## ${c.title}\n${body}`;
      })
      .join("\n\n")
      .slice(0, GRADE_CONTEXT_CHARS);

    // Grade through the shared grader. It reads as "grade this answer against ALL
    // of these concepts together" because the title joins them and the context
    // carries every body; quality/score come back clamped to [0,5]/[0,1].
    const grade = await gradeAnswer({
      question,
      answer,
      conceptTitle,
      conceptContext,
    });

    // Advance EVERY involved concept's mastery — the learner practised them all.
    // One settings read, then per-concept: current mastery (or fresh) → applyGrade
    // with the same grade + masteredThreshold → persist.
    const settings = await getSettings(uid);
    const nowMs = Date.now();
    await Promise.all(
      concepts.map(async (concept) => {
        const current: Mastery =
          (await getMastery(uid, concept.id)) ?? newMastery(concept.id);
        const updated = applyGrade(
          current,
          grade.quality,
          grade.score,
          nowMs,
          settings.masteredThreshold,
        );
        await setMastery(uid, updated);
      }),
    );

    return { grade };
  },
);
