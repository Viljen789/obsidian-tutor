/**
 * Vault ingestion — PUBLIC INTERFACE (Phase 1).
 *
 * Pipeline: unzip -> parse markdown + YAML frontmatter -> extract [[wikilinks]]
 * -> assemble concept graph -> infer prerequisite direction -> upsert concepts/*
 * idempotently (preserving mastery). The pure parsing/graph/prereq functions are
 * unit-tested without Firestore (see parse.ts / graph.ts / prereq.ts).
 */
import crypto from "node:crypto";
import AdmZip from "adm-zip";
import { getStorage } from "firebase-admin/storage";
import type {
  Concept,
  IngestVaultRequest,
  IngestVaultResponse,
} from "@tutor/shared";
import { authedCallable, HttpsError } from "../lib/callable";
import { llmSecrets } from "../lib/llm";
import { upsertConcepts } from "../lib/firebase";
import { parseNote } from "./parse";
import { assembleGraphWithWarnings } from "./graph";
import { inferPrerequisites, refinePrerequisitesWithLlm } from "./prereq";

/** One markdown note after frontmatter parsing, before graph assembly. */
export interface ParsedNote {
  sourcePath: string;
  title: string;
  subject: string;
  tags: string[];
  bodyMarkdown: string;
  /** Raw wikilink targets ([[Target]] / [[Target|alias]]) as written. */
  wikilinks: string[];
  frontmatter: Record<string, unknown>;
}

// Pure functions live in submodules; re-export to preserve the public surface.
export { parseNote } from "./parse";
export { assembleGraph, assembleGraphWithWarnings } from "./graph";
export { inferPrerequisites, refinePrerequisitesWithLlm } from "./prereq";

/** True for vault files we should parse: `.md`, not a dotfile / dotfolder. */
function isVaultMarkdown(entryName: string): boolean {
  const normalized = entryName.replace(/\\/g, "/");
  if (!normalized.toLowerCase().endsWith(".md")) return false;
  // Ignore anything under a dot-prefixed segment (e.g. ".obsidian/...") or a
  // dotfile basename.
  return !normalized.split("/").some((seg) => seg.startsWith("."));
}

// --- Callable: ingestVault ------------------------------------------------
export const ingestVault = authedCallable<IngestVaultRequest, IngestVaultResponse>(
  { secrets: llmSecrets },
  async ({ storagePath }, { uid }): Promise<IngestVaultResponse> => {
    if (!storagePath || typeof storagePath !== "string") {
      throw new HttpsError("invalid-argument", "storagePath is required.");
    }

    // 1. Download the uploaded zip from Cloud Storage.
    let zipBuffer: Buffer;
    try {
      const [buf] = await getStorage().bucket().file(storagePath).download();
      zipBuffer = buf;
    } catch (err) {
      throw new HttpsError(
        "not-found",
        `Could not download vault at ${storagePath}: ${(err as Error).message}`,
      );
    }

    // 2. Unzip and parse every markdown note (ignore non-md + dotfiles).
    let entries;
    try {
      entries = new AdmZip(zipBuffer).getEntries();
    } catch (err) {
      throw new HttpsError(
        "invalid-argument",
        `Uploaded file is not a valid zip: ${(err as Error).message}`,
      );
    }

    const notes = entries
      .filter((e) => !e.isDirectory && isVaultMarkdown(e.entryName))
      .map((e) => parseNote(e.entryName, e.getData().toString("utf8")));

    if (notes.length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "No markdown notes found in the uploaded vault.",
      );
    }

    // 3. Assemble the concept graph (caller supplies the timestamp — pure fn).
    const importId = crypto.randomUUID();
    const isoNow = new Date().toISOString();
    const { concepts: baseConcepts, warnings } = assembleGraphWithWarnings(
      notes,
      importId,
      isoNow,
    );

    // 4. Prerequisite inference: LLM refinement, falling back to the heuristic.
    let concepts: Concept[];
    try {
      concepts = await refinePrerequisitesWithLlm(baseConcepts);
    } catch (err) {
      warnings.push(
        `Prerequisite LLM refinement failed; used heuristic instead (${
          (err as Error).message
        }).`,
      );
      concepts = inferPrerequisites(baseConcepts);
    }

    // 5. Idempotent upsert — mastery is never touched.
    await upsertConcepts(uid, concepts);

    const subjects = [...new Set(concepts.map((c) => c.subject))].sort();
    return { importId, conceptCount: concepts.length, subjects, warnings };
  },
);
