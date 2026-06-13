/**
 * Prerequisite inference.
 *
 * Two layers, both keyed off the undirected wikilink graph:
 *
 *  1. `inferPrerequisites` — a PURE, deterministic heuristic (unit-tested). For
 *     every linked pair we orient the edge from the more *foundational* concept
 *     to the more *dependent* one. "Foundational" = shallower path depth and
 *     fewer outgoing links (leaves of the dependency chain are foundations the
 *     deeper notes build on). Ties broken by id for determinism.
 *
 *  2. `refinePrerequisitesWithLlm` — an OPTIONAL refinement used only inside the
 *     callable. For each wikilinked pair it asks the cheap classify model "is A
 *     a prerequisite of B?", batched and capped for cost, wrapped so any failure
 *     falls back to the heuristic. Never called from the pure unit tests.
 */
import type { Concept } from "@tutor/shared";
import { z } from "zod";
import { TOKEN_CAPS } from "../config";
import { MODELS, completeStructured } from "../lib/llm";

/** Depth = number of path segments (folder nesting). Shallower => more foundational. */
function pathDepth(sourcePath: string): number {
  return sourcePath.replace(/\\/g, "/").split("/").filter(Boolean).length;
}

/**
 * Lower score = more foundational. Outgoing-link count dominates (a note that
 * points at many others is "higher up" the chain); path depth is a tie-breaker.
 */
function foundationScore(c: Concept): number {
  return c.links.length * 10 + pathDepth(c.sourcePath);
}

/** Collect undirected linked pairs (a.id < b.id) from the `links` arrays. */
function linkedPairs(concepts: Concept[]): Array<[Concept, Concept]> {
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const pairs: Array<[Concept, Concept]> = [];
  for (const c of concepts) {
    for (const targetId of c.links) {
      const other = byId.get(targetId);
      if (!other) continue;
      const key = c.id < other.id ? `${c.id}|${other.id}` : `${other.id}|${c.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([c, other]);
    }
  }
  return pairs;
}

/**
 * Pure heuristic: returns a NEW concept array with `prerequisites` populated.
 * For each linked pair, the more foundational concept becomes a prerequisite of
 * the other (edge foundational -> dependent => dependent.prerequisites += found).
 */
export function inferPrerequisites(concepts: Concept[]): Concept[] {
  const prereqsOf = new Map<string, Set<string>>(
    concepts.map((c) => [c.id, new Set<string>()]),
  );

  for (const [a, b] of linkedPairs(concepts)) {
    const sa = foundationScore(a);
    const sb = foundationScore(b);
    // Equal scores: orient by id so the result is fully deterministic.
    const [foundational, dependent] =
      sa < sb || (sa === sb && a.id < b.id) ? [a, b] : [b, a];
    prereqsOf.get(dependent.id)?.add(foundational.id);
  }

  return concepts.map((c) => ({
    ...c,
    prerequisites: [...(prereqsOf.get(c.id) ?? [])].sort(),
  }));
}

// --- LLM refinement (callable-only) --------------------------------------

const PrereqAnswer = z.object({
  /** Index into the batch; echoes the pair so we can map answers back. */
  pairIndex: z.number().int(),
  /** True when `a` should be learned before `b`. */
  aIsPrerequisiteOfB: z.boolean(),
  /** True when the dependency actually runs the other way (b before a). */
  bIsPrerequisiteOfA: z.boolean(),
});
const PrereqBatchAnswer = z.object({ answers: z.array(PrereqAnswer) });

/** Cap how many pairs we ever send to the model in one ingestion (cost guard). */
const MAX_PAIRS = 60;
const BATCH_SIZE = 20;

/**
 * Refine the heuristic prerequisites with the cheap classify model.
 *
 * Starts from the heuristic result, then for each wikilinked pair asks the model
 * which direction the dependency runs and rewrites that pair's edge accordingly.
 * Batched and capped; the whole thing is wrapped in try/catch by the caller —
 * any failure leaves the heuristic prerequisites untouched.
 *
 * Pure-ish: no clock, no Firestore; it only calls the injected model helper.
 */
export async function refinePrerequisitesWithLlm(
  concepts: Concept[],
): Promise<Concept[]> {
  const base = inferPrerequisites(concepts);
  const byId = new Map(base.map((c) => [c.id, c]));
  const pairs = linkedPairs(base).slice(0, MAX_PAIRS);
  if (pairs.length === 0) return base;

  // Mutable prerequisite sets seeded from the heuristic.
  const prereqsOf = new Map<string, Set<string>>(
    base.map((c) => [c.id, new Set(c.prerequisites)]),
  );

  for (let start = 0; start < pairs.length; start += BATCH_SIZE) {
    const batch = pairs.slice(start, start + BATCH_SIZE);
    const lines = batch
      .map(([a, b], i) => {
        const at = a.title;
        const bt = b.title;
        const aex = a.bodyMarkdown.slice(0, 240).replace(/\s+/g, " ");
        const bex = b.bodyMarkdown.slice(0, 240).replace(/\s+/g, " ");
        return `Pair ${i}:\n  A = "${at}": ${aex}\n  B = "${bt}": ${bex}`;
      })
      .join("\n\n");

    const result = await completeStructured<z.infer<typeof PrereqBatchAnswer>>({
      model: MODELS.classify,
      maxTokens: TOKEN_CAPS.classify,
      system:
        "You decide prerequisite direction between pairs of study concepts. " +
        "A is a prerequisite of B if a learner should understand A before B " +
        "(A is more foundational). For each pair answer with booleans; if the " +
        "two are merely related with no clear ordering, set both to false.",
      prompt:
        `For each pair below, decide the prerequisite direction.\n\n${lines}\n\n` +
        `Return one answer object per pair with its pairIndex (0..${batch.length - 1}).`,
      schema: PrereqBatchAnswer,
    });

    for (const ans of result.answers) {
      const pair = batch[ans.pairIndex];
      if (!pair) continue;
      const [a, b] = pair;
      // Rewrite just this pair's edge based on the model's call.
      prereqsOf.get(b.id)?.delete(a.id);
      prereqsOf.get(a.id)?.delete(b.id);
      if (ans.aIsPrerequisiteOfB && !ans.bIsPrerequisiteOfA) {
        prereqsOf.get(b.id)?.add(a.id);
      } else if (ans.bIsPrerequisiteOfA && !ans.aIsPrerequisiteOfB) {
        prereqsOf.get(a.id)?.add(b.id);
      }
      // both true or both false => leave the pair with no directed edge.
    }
  }

  return base.map((c) => ({
    ...(byId.get(c.id) as Concept),
    prerequisites: [...(prereqsOf.get(c.id) ?? [])].sort(),
  }));
}
