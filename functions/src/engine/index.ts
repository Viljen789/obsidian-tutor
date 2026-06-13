/**
 * Adaptive learning engine — PUBLIC INTERFACE (Phase 3).
 *
 * Everything here except the `nextItem` callable is a PURE function:
 * no Firestore, no Date.now(), no I/O. Time is always passed in as `nowMs`
 * so the unit tests are deterministic. The algorithm is kept swappable
 * (SM-2 today, Bayesian Knowledge Tracing later) behind these signatures.
 *
 * The pure pieces live in sibling modules and are re-exported here so the
 * public surface (and the imports Phase 2's submitAnswer relies on) is stable:
 *   - sm2.ts       → updateSm2, Sm2State
 *   - mastery.ts   → newMastery, applyGrade
 *   - sequencer.ts → selectNextItem, SequencerInput
 */
import type { NextItem } from "@tutor/shared";
import { authedCallable } from "../lib/callable";
import { listConcepts, listMastery, getSettings } from "../lib/firebase";
import { selectNextItem } from "./sequencer";

// --- Pure engine surface (re-exported; signatures are the frozen contract) ---
export { updateSm2, type Sm2State } from "./sm2";
export { newMastery, applyGrade } from "./mastery";
export { selectNextItem, type SequencerInput } from "./sequencer";

// --- Callable: nextItem ---------------------------------------------------
// Loads the learner's concepts + mastery + settings and runs selectNextItem
// server-side. Date.now() is allowed here — this is the callable, not a pure fn.
export const nextItem = authedCallable<{ subject?: string }, NextItem>(
  {},
  async (data, ctx) => {
    const subject = data?.subject;
    const [concepts, masteries, settings] = await Promise.all([
      listConcepts(ctx.uid, subject),
      listMastery(ctx.uid),
      getSettings(ctx.uid),
    ]);
    return selectNextItem({
      concepts,
      masteries,
      nowMs: Date.now(),
      settings,
      subject,
    });
  },
);
