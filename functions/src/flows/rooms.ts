/**
 * rooms flows — group study rooms (Wave 5b).
 *
 * Only **create** and **join** are server-side. Once you're a member you
 * read/update the room directly (pomodoro/chat/leave are client writes per the
 * rules); but a NON-member can't read a room to look it up by code, and join
 * codes must be globally unique — both of which require a trusted server.
 *
 * - createRoom: validate a non-empty name, mint a UNIQUE short join code
 *   (collision-checked + retried, exactly like the friend code in social.ts),
 *   and create `rooms/{uuid}` owned by the caller with members=[uid] and
 *   DEFAULT_POMODORO. Returns { roomId, code }.
 * - joinRoom: resolve a room by `code` (query rooms where code == code — a
 *   non-member can't read it client-side, hence server-side). Idempotent if the
 *   caller is already a member; rejects an unknown code (not-found) or a full
 *   room (capacity cap → failed-precondition); otherwise arrayUnions the caller.
 *   Returns { roomId }.
 */
import crypto from "node:crypto";
import {
  paths,
  DEFAULT_POMODORO,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type JoinRoomRequest,
  type JoinRoomResponse,
  type Room,
} from "@tutor/shared";
import { authedCallable, HttpsError } from "../lib/callable";
import { db, FieldValue } from "../lib/firebase";

// Crockford-ish alphabet: uppercase, no confusable 0/O/1/I (and no U to dodge
// accidental profanity). A 6-char code over 31 symbols is ~29.7 bits of entropy
// — unguessable at human scale, short enough to read aloud over a call.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 6;
const MINT_ATTEMPTS = 8;

/** Max members in a room — keeps a study group small and the doc bounded. */
const MAX_MEMBERS = 12;

/** One random join code (uniform over the alphabet via randomInt). */
function randomRoomCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/** True if some room already uses this join code. */
async function roomCodeTaken(code: string): Promise<boolean> {
  const snap = await db
    .collection(paths.rooms())
    .where("code", "==", code)
    .limit(1)
    .get();
  return !snap.empty;
}

/** Mint a join code not currently in use, retrying on the rare collision. */
async function mintUniqueRoomCode(): Promise<string> {
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
    const code = randomRoomCode();
    if (!(await roomCodeTaken(code))) return code;
  }
  // Astronomically unlikely with ~29.7 bits of entropy and a tiny namespace.
  throw new HttpsError("internal", "Could not allocate a unique room code.");
}

export const createRoom = authedCallable<CreateRoomRequest, CreateRoomResponse>(
  {},
  async (data, { uid }): Promise<CreateRoomResponse> => {
    const name = data.name?.trim();
    if (!name) {
      throw new HttpsError("invalid-argument", "A room name is required.");
    }
    if (name.length > 60) {
      throw new HttpsError("invalid-argument", "Room name is too long (max 60 characters).");
    }

    const code = await mintUniqueRoomCode();
    const roomId = crypto.randomUUID();

    const room: Room = {
      id: roomId,
      name,
      ownerId: uid,
      code,
      members: [uid],
      pomodoro: DEFAULT_POMODORO,
      createdAt: new Date().toISOString(),
    };
    await db.doc(paths.roomDoc(roomId)).set(room);

    return { roomId, code };
  },
);

export const joinRoom = authedCallable<JoinRoomRequest, JoinRoomResponse>(
  {},
  async (data, { uid }): Promise<JoinRoomResponse> => {
    const code = data.code?.trim().toUpperCase();
    if (!code) {
      throw new HttpsError("invalid-argument", "A room code is required.");
    }

    // Resolve the code to a room (discovery is by code only — a non-member can't
    // read the room client-side, which is why this runs server-side).
    const matches = await db
      .collection(paths.rooms())
      .where("code", "==", code)
      .limit(1)
      .get();
    const roomDoc = matches.docs[0];
    if (!roomDoc) {
      throw new HttpsError("not-found", "No room found with that code.");
    }
    const room = roomDoc.data() as Room;
    const roomId = room.id;

    // Already a member → succeed without a write (idempotent re-join).
    if (room.members.includes(uid)) {
      return { roomId };
    }

    if (room.members.length >= MAX_MEMBERS) {
      throw new HttpsError("failed-precondition", "This room is full.");
    }

    // arrayUnion is itself idempotent, so a racing double-join can't duplicate
    // the uid even though we checked membership above.
    await db.doc(paths.roomDoc(roomId)).update({
      members: FieldValue.arrayUnion(uid),
    });

    return { roomId };
  },
);
