/**
 * Firestore data-access layer. All reads/writes for the learner's data go
 * through here so every agent uses the same paths, the same ISO-timestamp
 * convention, and the same idempotent upsert semantics.
 *
 * Storage convention: timestamps are ISO-8601 strings (see domain.ts). For a
 * single-user vault (hundreds of concepts) the sequencer loads all concepts +
 * mastery and computes in memory, so no Timestamp range indexes are needed.
 */
import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import {
  paths,
  explanationCacheKey,
  DEFAULT_USER_SETTINGS,
  type CheatSheetEntry,
  type Concept,
  type DiagramEntry,
  type ExplanationCacheEntry,
  type ExplanationDepth,
  type FlashcardDeck,
  type Mastery,
  type UserSettings,
} from "@tutor/shared";

// Resolve the default Storage bucket so `getStorage().bucket()` works in the
// callable (ingestVault). Prefer the runtime-provided FIREBASE_CONFIG (correct
// in production), falling back to `<project>.appspot.com` for the emulator.
function defaultBucket(): string {
  try {
    const cfg = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
    if (cfg?.storageBucket) return cfg.storageBucket as string;
  } catch {
    /* fall through to derived name */
  }
  const projectId =
    process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "demo-tutor";
  return `${projectId}.appspot.com`;
}

if (getApps().length === 0) initializeApp({ storageBucket: defaultBucket() });
export const db = getFirestore();

// --- Concepts -------------------------------------------------------------

export async function getConcept(uid: string, conceptId: string): Promise<Concept | null> {
  const snap = await db.doc(paths.concept(uid, conceptId)).get();
  return snap.exists ? (snap.data() as Concept) : null;
}

/** Persist a manual prerequisite override on a concept (merge — other fields untouched). */
export async function setManualPrerequisites(
  uid: string,
  conceptId: string,
  prerequisites: string[],
): Promise<void> {
  await db
    .doc(paths.concept(uid, conceptId))
    .set({ manualPrerequisites: prerequisites }, { merge: true });
}

export async function listConcepts(uid: string, subject?: string): Promise<Concept[]> {
  let q = db.collection(paths.concepts(uid)) as FirebaseFirestore.Query;
  if (subject) q = q.where("subject", "==", subject);
  const snap = await q.get();
  return snap.docs.map((d) => d.data() as Concept);
}

/**
 * Idempotent upsert: writes concepts by id with merge so re-importing a vault
 * updates content without wiping unrelated fields. Mastery lives in a separate
 * collection and is never touched here, preserving learning history.
 */
export async function upsertConcepts(uid: string, concepts: Concept[]): Promise<void> {
  const BATCH_LIMIT = 450;
  for (let i = 0; i < concepts.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const c of concepts.slice(i, i + BATCH_LIMIT)) {
      batch.set(db.doc(paths.concept(uid, c.id)), c, { merge: true });
    }
    await batch.commit();
  }
}

/**
 * Deletes every concept in a subject along with its mastery doc and all cached
 * explanations (one per depth). The inverse of an import — used to clean up a
 * mistaken or stale vault import.
 *
 * Each concept fans out to up to 6 deletes (1 concept + 1 mastery + 1 flashcard
 * deck + 3 cache depths), so we chunk by concept to stay under Firestore's
 * 500-ops-per-batch limit (80 * 6 = 480). Batches commit sequentially. Returns
 * the number of concepts deleted (0 if the subject has none).
 */
export async function deleteSubjectData(uid: string, subject: string): Promise<number> {
  const snap = await db
    .collection(paths.concepts(uid))
    .where("subject", "==", subject)
    .get();
  const conceptIds = snap.docs.map((d) => d.id);

  const DEPTHS: ExplanationDepth[] = ["refresher", "standard", "deep"];
  const CONCEPTS_PER_BATCH = 80; // 80 * 6 deletes = 480, under the 500 limit
  for (let i = 0; i < conceptIds.length; i += CONCEPTS_PER_BATCH) {
    const batch = db.batch();
    for (const id of conceptIds.slice(i, i + CONCEPTS_PER_BATCH)) {
      batch.delete(db.doc(paths.concept(uid, id)));
      batch.delete(db.doc(paths.masteryDoc(uid, id)));
      batch.delete(db.doc(paths.flashcardDoc(uid, id)));
      for (const depth of DEPTHS) {
        batch.delete(db.doc(paths.explanationCacheDoc(uid, id, depth)));
      }
    }
    await batch.commit();
  }

  return conceptIds.length;
}

// --- Mastery (learner model) ---------------------------------------------

export async function getMastery(uid: string, conceptId: string): Promise<Mastery | null> {
  const snap = await db.doc(paths.masteryDoc(uid, conceptId)).get();
  return snap.exists ? (snap.data() as Mastery) : null;
}

export async function listMastery(uid: string): Promise<Record<string, Mastery>> {
  const snap = await db.collection(paths.mastery(uid)).get();
  const out: Record<string, Mastery> = {};
  for (const d of snap.docs) out[d.id] = d.data() as Mastery;
  return out;
}

export async function setMastery(uid: string, mastery: Mastery): Promise<void> {
  await db.doc(paths.masteryDoc(uid, mastery.conceptId)).set(mastery);
}

// --- Explanation cache ----------------------------------------------------

export async function getExplanationCache(
  uid: string,
  conceptId: string,
  depth: ExplanationDepth,
): Promise<ExplanationCacheEntry | null> {
  const snap = await db
    .doc(paths.explanationCacheDoc(uid, conceptId, depth))
    .get();
  return snap.exists ? (snap.data() as ExplanationCacheEntry) : null;
}

export async function setExplanationCache(
  uid: string,
  entry: ExplanationCacheEntry,
): Promise<void> {
  await db
    .doc(paths.explanationCacheDoc(uid, entry.conceptId, entry.depth))
    .set(entry);
  void explanationCacheKey; // path builder kept in sync via shared
}

// --- Flashcard decks ------------------------------------------------------
// One cached deck per concept (like explanationCache): generated on first
// request, then served from Firestore so repeat drills never re-spend a call.

export async function getFlashcardDeck(
  uid: string,
  conceptId: string,
): Promise<FlashcardDeck | null> {
  const snap = await db.doc(paths.flashcardDoc(uid, conceptId)).get();
  return snap.exists ? (snap.data() as FlashcardDeck) : null;
}

export async function setFlashcardDeck(uid: string, deck: FlashcardDeck): Promise<void> {
  await db.doc(paths.flashcardDoc(uid, deck.conceptId)).set(deck);
}

// --- Cheat sheets ---------------------------------------------------------
// One cached one-pager per subject, keyed by an encoded subject string.

export async function getCheatSheet(uid: string, key: string): Promise<CheatSheetEntry | null> {
  const snap = await db.doc(paths.cheatSheetDoc(uid, key)).get();
  return snap.exists ? (snap.data() as CheatSheetEntry) : null;
}

export async function setCheatSheet(
  uid: string,
  key: string,
  entry: CheatSheetEntry,
): Promise<void> {
  await db.doc(paths.cheatSheetDoc(uid, key)).set(entry);
}

// --- Diagrams -------------------------------------------------------------
// One cached Mermaid diagram per concept (like explanationCache).

export async function getDiagram(uid: string, conceptId: string): Promise<DiagramEntry | null> {
  const snap = await db.doc(paths.diagramDoc(uid, conceptId)).get();
  return snap.exists ? (snap.data() as DiagramEntry) : null;
}

export async function setDiagram(uid: string, entry: DiagramEntry): Promise<void> {
  await db.doc(paths.diagramDoc(uid, entry.conceptId)).set(entry);
}

// --- Settings -------------------------------------------------------------

export async function getSettings(uid: string): Promise<UserSettings> {
  const snap = await db.doc(paths.user(uid)).get();
  const data = snap.data();
  return { ...DEFAULT_USER_SETTINGS, ...(data?.settings ?? {}) };
}

export { FieldValue };
