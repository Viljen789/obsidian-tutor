/**
 * setPrerequisites flow — manual prerequisite override.
 *
 * Lets the learner correct the inferred prerequisite graph for one concept. The
 * override is stored as `manualPrerequisites` on the concept doc; the sequencer
 * prefers it over the inferred list, and ingestion never touches it, so edits
 * survive re-imports. Concepts are Functions-written, so this must be a callable
 * (the client can't write concept docs directly).
 */
import type {
  SetPrerequisitesRequest,
  SetPrerequisitesResponse,
} from "@tutor/shared";
import { authedCallable, HttpsError } from "../lib/callable";
import { getConcept, setManualPrerequisites } from "../lib/firebase";

export const setPrerequisites = authedCallable<
  SetPrerequisitesRequest,
  SetPrerequisitesResponse
>({}, async (data, { uid }): Promise<SetPrerequisitesResponse> => {
  if (!data.conceptId || typeof data.conceptId !== "string") {
    throw new HttpsError("invalid-argument", "conceptId is required.");
  }
  const concept = await getConcept(uid, data.conceptId);
  if (!concept) {
    throw new HttpsError("not-found", `Concept not found: ${data.conceptId}`);
  }

  // Sanitize: keep distinct, non-empty string ids; never let a concept be its
  // own prerequisite. (Cycle-prevention beyond self is left to the UI.)
  const prerequisites = Array.from(
    new Set(
      (data.prerequisites ?? []).filter(
        (p): p is string => typeof p === "string" && p.length > 0 && p !== data.conceptId,
      ),
    ),
  );

  await setManualPrerequisites(uid, data.conceptId, prerequisites);
  return { conceptId: data.conceptId, manualPrerequisites: prerequisites };
});
