/**
 * createShare — snapshot a subject into a public, read-only shared deck.
 *
 * Takes the signed-in user's concepts in `data.subject` and freezes them into a
 * top-level `shares/{shareId}` doc (paths.shareDoc) that anyone with the link
 * can read (rules: public-read, Functions-write). The id is a random UUID, so a
 * share is unguessable / effectively unlisted.
 *
 * Each concept becomes a SharedConcept with the best-available explanation:
 * the cached "standard" explanation markdown if one exists, else the raw note
 * body — so a deck reads well even before any explanation has been generated.
 *
 * Privacy: the snapshot carries only title + subject + explanation markdown.
 * Mastery, spaced-repetition state, history, source paths, tags and everything
 * else private to the learner stay behind — they're never copied into the
 * public doc. `ownerName` is the display name (or null), nothing more.
 *
 * 404 (not-found) if the subject has no concepts.
 */
import crypto from "node:crypto";
import { getAuth } from "firebase-admin/auth";
import {
  paths,
  type CreateShareRequest,
  type CreateShareResponse,
  type ShareDoc,
  type SharedConcept,
} from "@tutor/shared";
import { authedCallable, HttpsError } from "../lib/callable";
import { db, listConcepts, getExplanationCache } from "../lib/firebase";

export const createShare = authedCallable<CreateShareRequest, CreateShareResponse>(
  {},
  async (data, { uid }): Promise<CreateShareResponse> => {
    const subject = data.subject?.trim();
    if (!subject) {
      throw new HttpsError("invalid-argument", "A non-empty subject is required.");
    }

    const concepts = await listConcepts(uid, subject);
    if (concepts.length === 0) {
      throw new HttpsError("not-found", `No concepts found for subject "${subject}".`);
    }

    // Build a SharedConcept per concept: prefer the cached "standard" explanation
    // (the depth the lesson loop uses by default), falling back to the raw note
    // body so a share works even before any explanation has been generated.
    const shared: SharedConcept[] = await Promise.all(
      concepts.map(async (c): Promise<SharedConcept> => {
        const cached = await getExplanationCache(uid, c.id, "standard");
        return {
          id: c.id,
          title: c.title,
          subject: c.subject,
          markdown: cached?.markdown ?? c.bodyMarkdown,
        };
      }),
    );

    // Owner display name is best-effort: a deleted/anonymous account or a lookup
    // failure simply yields null rather than blocking the share.
    let ownerName: string | null = null;
    try {
      const user = await getAuth().getUser(uid);
      ownerName = user.displayName ?? null;
    } catch {
      ownerName = null;
    }

    const shareId = crypto.randomUUID();
    const doc: ShareDoc = {
      id: shareId,
      subject,
      ownerName,
      createdAt: new Date().toISOString(),
      concepts: shared,
    };

    await db.doc(paths.shareDoc(shareId)).set(doc);

    return { shareId, conceptCount: shared.length };
  },
);
