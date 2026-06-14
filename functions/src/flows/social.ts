/**
 * social flows — profiles + friends (Wave 5 collaboration).
 *
 * All four are server-trusted because they touch the social graph, which must
 * stay consistent and unforgeable. Friend discovery is by an unguessable
 * `friendCode` (never email/username search), and every friendship edge is
 * written on BOTH sides server-side so it can't be half-forged from a client.
 *
 * - ensureProfile: upsert `profiles/{uid}` from the auth user's name/photo.
 *   First call mints a unique short friendCode (collision-checked + retried);
 *   later calls keep it. Idempotent. Returns the PublicProfile.
 * - sendFriendRequest: resolve a target by friendCode and write a pending
 *   `friendRequests/{id}` doc (denormalising the sender's name/photo). Rejects
 *   self-adds, existing friendships, and duplicate pending requests.
 * - respondFriendRequest: only the recipient may respond. On accept, the
 *   friendship is written to BOTH friend lists in one batch with denormalised
 *   display info; the request is marked accepted/declined.
 * - removeFriend: delete the friend doc on BOTH sides in one batch.
 */
import crypto from "node:crypto";
import { getAuth } from "firebase-admin/auth";
import {
  paths,
  type EnsureProfileRequest,
  type EnsureProfileResponse,
  type Friend,
  type FriendRequest,
  type PublicProfile,
  type RemoveFriendRequest,
  type RemoveFriendResponse,
  type RespondFriendRequestRequest,
  type RespondFriendRequestResponse,
  type SendFriendRequestRequest,
  type SendFriendRequestResponse,
} from "@tutor/shared";
import { authedCallable, HttpsError } from "../lib/callable";
import { db } from "../lib/firebase";

// Crockford-ish alphabet: uppercase, no confusable 0/O/1/I (and no U to dodge
// accidental profanity). A 7-char code over 31 symbols is ~27.6 bits of
// entropy — unguessable at human scale, short enough to read aloud.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 7;
const MINT_ATTEMPTS = 8;

/** One random friendCode (uniform over the alphabet via rejection-free randomInt). */
function randomFriendCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/** True if some profile already owns this friendCode. */
async function friendCodeTaken(code: string): Promise<boolean> {
  const snap = await db
    .collection(paths.profiles())
    .where("friendCode", "==", code)
    .limit(1)
    .get();
  return !snap.empty;
}

/** Mint a friendCode not currently in use, retrying on the rare collision. */
async function mintUniqueFriendCode(): Promise<string> {
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
    const code = randomFriendCode();
    if (!(await friendCodeTaken(code))) return code;
  }
  // Astronomically unlikely with 27.6 bits of entropy and an empty namespace.
  throw new HttpsError("internal", "Could not allocate a unique friend code.");
}

/**
 * Best-effort display info for a uid: prefer the (denormalised) public profile,
 * fall back to the live auth user, and finally to nulls. Never throws — a
 * missing profile/account must not block a social action.
 */
async function displayInfoFor(
  uid: string,
): Promise<{ displayName: string | null; photoURL: string | null }> {
  const profSnap = await db.doc(paths.profileDoc(uid)).get();
  if (profSnap.exists) {
    const p = profSnap.data() as PublicProfile;
    return { displayName: p.displayName ?? null, photoURL: p.photoURL ?? null };
  }
  try {
    const user = await getAuth().getUser(uid);
    return { displayName: user.displayName ?? null, photoURL: user.photoURL ?? null };
  } catch {
    return { displayName: null, photoURL: null };
  }
}

export const ensureProfile = authedCallable<EnsureProfileRequest, EnsureProfileResponse>(
  {},
  async (_data, { uid }): Promise<EnsureProfileResponse> => {
    // Name/photo come from the auth token, not the client — the profile is the
    // public projection of the verified account, so it can't be spoofed.
    const user = await getAuth().getUser(uid);
    const displayName = user.displayName ?? null;
    const photoURL = user.photoURL ?? null;

    const ref = db.doc(paths.profileDoc(uid));
    const existing = await ref.get();

    // Existing profile → refresh name/photo but KEEP the original friendCode
    // (it's a stable handle others may already have saved).
    const friendCode = existing.exists
      ? (existing.data() as PublicProfile).friendCode
      : await mintUniqueFriendCode();

    const profile: PublicProfile = {
      uid,
      displayName,
      photoURL,
      friendCode,
      updatedAt: new Date().toISOString(),
    };
    await ref.set(profile);
    return profile;
  },
);

export const sendFriendRequest = authedCallable<
  SendFriendRequestRequest,
  SendFriendRequestResponse
>({}, async (data, { uid }): Promise<SendFriendRequestResponse> => {
  const code = data.friendCode?.trim();
  if (!code) {
    throw new HttpsError("invalid-argument", "A friend code is required.");
  }

  // Resolve the code to a target profile (discovery is by code only).
  const matches = await db
    .collection(paths.profiles())
    .where("friendCode", "==", code)
    .limit(1)
    .get();
  const targetDoc = matches.docs[0];
  if (!targetDoc) {
    throw new HttpsError("not-found", "No user found with that friend code.");
  }
  const target = targetDoc.data() as PublicProfile;
  const targetUid = target.uid;

  if (targetUid === uid) {
    throw new HttpsError("invalid-argument", "You can't add yourself.");
  }

  // Already friends? (Check my side of the bidirectional edge.)
  const alreadyFriends = await db.doc(paths.friendDoc(uid, targetUid)).get();
  if (alreadyFriends.exists) {
    throw new HttpsError("already-exists", "You're already friends.");
  }

  // Duplicate outstanding request from me to them?
  const dup = await db
    .collection(paths.friendRequests())
    .where("fromUid", "==", uid)
    .where("toUid", "==", targetUid)
    .where("status", "==", "pending")
    .limit(1)
    .get();
  if (!dup.empty) {
    throw new HttpsError("already-exists", "You already have a pending request to this user.");
  }

  // Denormalise MY info onto the request so the recipient renders it directly.
  const me = await displayInfoFor(uid);
  const id = crypto.randomUUID();
  const request: FriendRequest = {
    id,
    fromUid: uid,
    toUid: targetUid,
    status: "pending",
    createdAt: new Date().toISOString(),
    fromName: me.displayName,
    fromPhoto: me.photoURL,
  };
  await db.doc(paths.friendRequestDoc(id)).set(request);

  return { ok: true, toName: target.displayName ?? null };
});

export const respondFriendRequest = authedCallable<
  RespondFriendRequestRequest,
  RespondFriendRequestResponse
>({}, async (data, { uid }): Promise<RespondFriendRequestResponse> => {
  const requestId = data.requestId?.trim();
  if (!requestId) {
    throw new HttpsError("invalid-argument", "A requestId is required.");
  }

  const ref = db.doc(paths.friendRequestDoc(requestId));
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Friend request not found.");
  }
  const request = snap.data() as FriendRequest;

  // Only the recipient may act on the request, and only while it's pending.
  if (request.toUid !== uid) {
    throw new HttpsError("permission-denied", "Only the recipient can respond to this request.");
  }
  if (request.status !== "pending") {
    throw new HttpsError("failed-precondition", "This request has already been answered.");
  }

  const batch = db.batch();

  if (data.accept) {
    // Write BOTH sides of the friendship server-side so it can't be half-forged.
    // Each friend doc carries the OTHER person's denormalised display info.
    const them = request.fromUid;
    const since = new Date().toISOString();
    const [myInfo, theirInfo] = await Promise.all([
      displayInfoFor(uid),
      displayInfoFor(them),
    ]);

    const theirFriendDoc: Friend = {
      uid: them,
      displayName: theirInfo.displayName,
      photoURL: theirInfo.photoURL,
      since,
    };
    const myFriendDoc: Friend = {
      uid,
      displayName: myInfo.displayName,
      photoURL: myInfo.photoURL,
      since,
    };

    batch.set(db.doc(paths.friendDoc(uid, them)), theirFriendDoc); // in MY list: them
    batch.set(db.doc(paths.friendDoc(them, uid)), myFriendDoc); //   in THEIR list: me
    batch.update(ref, { status: "accepted" });
  } else {
    batch.update(ref, { status: "declined" });
  }

  await batch.commit();
  return { ok: true };
});

export const removeFriend = authedCallable<RemoveFriendRequest, RemoveFriendResponse>(
  {},
  async (data, { uid }): Promise<RemoveFriendResponse> => {
    const otherUid = data.uid?.trim();
    if (!otherUid) {
      throw new HttpsError("invalid-argument", "A uid is required.");
    }

    // Tear down both sides of the bidirectional edge in one atomic batch.
    const batch = db.batch();
    batch.delete(db.doc(paths.friendDoc(uid, otherUid)));
    batch.delete(db.doc(paths.friendDoc(otherUid, uid)));
    await batch.commit();

    return { ok: true };
  },
);
