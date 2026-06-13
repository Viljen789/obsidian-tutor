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

// Phase 3 — adaptive sequencer
export { nextItem } from "./engine/index";
