/**
 * Fully-typed client for the Cloud Function callables. Reads the function names
 * and request/response types from `@tutor/shared`, so the UI cannot call a
 * function with the wrong shape — the contract is enforced at compile time.
 *
 * Usage:  const res = await api.explainConcept({ conceptId });  // res is typed
 */
import { httpsCallable } from "firebase/functions";
import { CALLABLE, type CallableContract } from "@tutor/shared";
import { functions } from "./firebase";

function callable<K extends keyof CallableContract>(name: K) {
  const fn = httpsCallable<
    CallableContract[K]["request"],
    CallableContract[K]["response"]
  >(functions, CALLABLE[name]);
  return async (
    req: CallableContract[K]["request"],
  ): Promise<CallableContract[K]["response"]> => (await fn(req)).data;
}

export const api = {
  ingestVault: callable("ingestVault"),
  explainConcept: callable("explainConcept"),
  generateQuestions: callable("generateQuestions"),
  submitAnswer: callable("submitAnswer"),
  requestHint: callable("requestHint"),
  nextItem: callable("nextItem"),
  deleteSubject: callable("deleteSubject"),
};
