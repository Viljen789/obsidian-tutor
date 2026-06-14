/**
 * sharing flows — share a subject with a friend (Wave 5b).
 *
 * The "public link" share (createShare.ts) drops a snapshot at a top-level,
 * anyone-with-the-link `shares/{id}` doc. THIS pair reuses that same snapshot
 * doc but targets it at a specific friend: share writes an `InboxItem` into the
 * friend's inbox, and import copies the deck into the importer's OWN vault.
 *
 * - shareSubjectToFriend: verify `toUid` is the caller's friend (the bidirectional
 *   friend edge `friendDoc(uid, toUid)` must exist — you can only share with
 *   friends), snapshot the subject exactly like createShare (each concept's best
 *   explanation: the cached "standard" markdown if present, else the raw note
 *   body), write the `shares/{shareId}` doc, then drop an `InboxItem` into the
 *   friend's inbox (Functions-write). Returns { ok, shareId }.
 * - importSharedDeck: read `shares/{shareId}`, turn each SharedConcept into a
 *   ParsedNote, and run it through the SAME ingest pipeline as a vault import so
 *   the importer gets their OWN concepts — fresh mastery, idempotent upsert. The
 *   private snapshot (only title + subject + markdown) carries nothing of the
 *   sharer's mastery/schedule. Returns { importId, conceptCount, subject }.
 *
 * The client deletes the inbox item after a successful import (it owns its own
 * inbox per the rules), so import never needs the inbox id.
 */
import crypto from "node:crypto";
import { getAuth } from "firebase-admin/auth";
import {
  paths,
  type ImportSharedDeckRequest,
  type ImportSharedDeckResponse,
  type InboxItem,
  type ShareDoc,
  type SharedConcept,
  type ShareSubjectToFriendRequest,
  type ShareSubjectToFriendResponse,
} from "@tutor/shared";
import { authedCallable, HttpsError } from "../lib/callable";
import { db, listConcepts, getExplanationCache } from "../lib/firebase";
import { ingestParsedNotes, type ParsedNote } from "../ingest/index";

/**
 * Best-effort display name for a uid (the sharer's, for the inbox item). A
 * deleted/anonymous account or a lookup failure simply yields null rather than
 * blocking the share — same posture as createShare's ownerName.
 */
async function displayNameFor(uid: string): Promise<string | null> {
  try {
    const user = await getAuth().getUser(uid);
    return user.displayName ?? null;
  } catch {
    return null;
  }
}

/** Filesystem-safe basename for a SharedConcept's synthetic `Shared/<title>.md`. */
function safeTitle(title: string): string {
  const cleaned = title.replace(/[/\\:*?"<>|]/g, "_").trim();
  return cleaned.length > 0 ? cleaned : "Untitled";
}

export const shareSubjectToFriend = authedCallable<
  ShareSubjectToFriendRequest,
  ShareSubjectToFriendResponse
>({}, async (data, { uid }): Promise<ShareSubjectToFriendResponse> => {
  const subject = data.subject?.trim();
  if (!subject) {
    throw new HttpsError("invalid-argument", "A non-empty subject is required.");
  }
  const toUid = data.toUid?.trim();
  if (!toUid) {
    throw new HttpsError("invalid-argument", "A recipient (toUid) is required.");
  }

  // You can only share with friends: the bidirectional friend edge in MY list
  // must exist. (Friendships are written on both sides server-side, so my side
  // existing means we're genuinely friends — it can't be half-forged.)
  const friend = await db.doc(paths.friendDoc(uid, toUid)).get();
  if (!friend.exists) {
    throw new HttpsError("failed-precondition", "You can only share with friends.");
  }

  // Snapshot the subject — same shape as createShare: prefer the cached
  // "standard" explanation, falling back to the raw note body so a deck reads
  // well even before any explanation has been generated. 404 if the subject is
  // empty so we never share an empty deck.
  const concepts = await listConcepts(uid, subject);
  if (concepts.length === 0) {
    throw new HttpsError("not-found", `No concepts found for subject "${subject}".`);
  }

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

  const ownerName = await displayNameFor(uid);

  // Write the snapshot doc (unguessable id; public-read, Functions-write).
  const shareId = crypto.randomUUID();
  const shareDoc: ShareDoc = {
    id: shareId,
    subject,
    ownerName,
    createdAt: new Date().toISOString(),
    concepts: shared,
  };
  await db.doc(paths.shareDoc(shareId)).set(shareDoc);

  // Drop an item in the friend's inbox (Functions-write). fromName is
  // denormalised so the recipient can render it without an extra read.
  const itemId = crypto.randomUUID();
  const item: InboxItem = {
    id: itemId,
    type: "sharedDeck",
    shareId,
    subject,
    fromUid: uid,
    fromName: ownerName,
    createdAt: new Date().toISOString(),
  };
  await db.doc(paths.inboxDoc(toUid, itemId)).set(item);

  return { ok: true, shareId };
});

export const importSharedDeck = authedCallable<
  ImportSharedDeckRequest,
  ImportSharedDeckResponse
>({}, async (data, { uid }): Promise<ImportSharedDeckResponse> => {
  const shareId = data.shareId?.trim();
  if (!shareId) {
    throw new HttpsError("invalid-argument", "A shareId is required.");
  }

  const snap = await db.doc(paths.shareDoc(shareId)).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "That shared deck no longer exists.");
  }
  const share = snap.data() as ShareDoc;

  // Convert each SharedConcept into a ParsedNote and run it through the SAME
  // ingest pipeline a vault import uses — so the importer ends up with their OWN
  // concepts (fresh mastery; idempotent upsert preserves any prior learning if
  // they re-import). Only the markdown body crosses over; no mastery/schedule.
  const notes: ParsedNote[] = share.concepts.map((c): ParsedNote => ({
    sourcePath: `Shared/${safeTitle(c.title)}.md`,
    title: c.title,
    subject: c.subject,
    tags: [],
    bodyMarkdown: c.markdown,
    wikilinks: [],
    frontmatter: {},
    imageEmbeds: [],
  }));

  const result = await ingestParsedNotes(uid, notes);

  return {
    importId: result.importId,
    conceptCount: result.conceptCount,
    subject: share.subject,
  };
});
