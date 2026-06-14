/**
 * Cloud Functions entrypoint. Region/instance defaults are set globally so each
 * callable stays declarative. Each export below is filled in by its phase agent;
 * the signatures and names here are frozen as the deployment contract.
 */
import { setGlobalOptions } from "firebase-functions/v2";
import { DEFAULTS } from "./config";

setGlobalOptions({
  region: DEFAULTS.region,
  maxInstances: DEFAULTS.maxInstances,
});

// Phase 1 — ingestion
export { ingestVault } from "./ingest/index";

// Phase 2 — AI-in-the-loop
export { explainConcept, generateQuestions, requestHint } from "./ai/index";
export { submitAnswer } from "./flows/submitAnswer";

// Wave 3 — streaming explanation (progressive render; falls back to explainConcept)
export { explainConceptStream } from "./flows/explainStream";

// Phase 3 — adaptive sequencer
export { nextItem } from "./engine/index";

// Vault management
export { deleteSubject } from "./flows/deleteSubject";
export { syncGitHub } from "./flows/githubSync";

// Practice exam
export { generateExam } from "./flows/generateExam";

// Wave 2 — flashcard drills (generate decks + self-graded reviews)
export { generateFlashcards } from "./flows/flashcards";
export { reviewCard } from "./flows/reviewCard";

// Wave 3 — ask-a-follow-up tutor chat
export { tutorChat } from "./flows/tutorChat";

// Wave 3 — past-exam → mock generator
export { generateMock } from "./flows/generateMock";

// Wave 3 — manual prerequisite override
export { setPrerequisites } from "./flows/setPrerequisites";

// Wave 3 — read-only shared decks
export { createShare } from "./flows/createShare";
