/**
 * Group study rooms (Wave 5b): the data layer for a shared pomodoro + chat +
 * live member presence. Three live Firestore subscriptions power "feels alive":
 *
 *   1. The room doc itself (`useRoom`) — the pomodoro lives here. The countdown
 *      is NEVER written per-second: the writer stamps `startedAt` + `durationSec`
 *      once, and every client computes `remaining = durationSec - (now - startedAt)`
 *      and ticks locally. So all members see the same number with zero traffic.
 *   2. Messages (`useRoomMessages`) — an ordered, capped live feed; `sendMessage`
 *      appends a doc with denormalised author name (no per-message profile read).
 *   3. Presence (`useRoomPresence`) — each member writes a heartbeat into the
 *      room's presence subcollection; "online" is simply a *recent* lastSeen.
 *
 * Split of truth (mirrors CONTRACTS.md): createRoom / joinRoom are server
 * callables (they mint/verify the join code; a non-member can't read a room to
 * find it). Everything members can do once inside — drive the pomodoro, chat,
 * heartbeat, leave — are direct client writes the rules allow.
 */
import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  addDoc,
  arrayRemove,
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import type {
  PomodoroPhase,
  PomodoroState,
  PublicProfile,
  Room,
  RoomMessage,
} from "@tutor/shared";
import { paths } from "@tutor/shared";
import { db } from "./firebase";
import { useAuth } from "./auth";

// ---------------------------------------------------------------------------
// Tunables — heartbeat cadence + freshness, and the message cap.
// ---------------------------------------------------------------------------

/** How often a member re-writes their room presence doc, in ms (~25s). */
export const ROOM_HEARTBEAT_MS = 25_000;

/** How long a room `lastSeen` stamp counts as "online", in ms (~70s). */
export const ROOM_FRESH_MS = 70_000;

/** Most recent N messages kept in the live feed. */
export const MESSAGE_CAP = 100;

// ---------------------------------------------------------------------------
// Pomodoro pure helpers — shared by the writers and the per-second display.
// ---------------------------------------------------------------------------

/**
 * Seconds left in the current phase: `durationSec - (now - startedAt)`, floored
 * at 0. Idle (or a missing/!unparseable startedAt) has no countdown → 0. `now`
 * is epoch-millis (defaults to the wall clock) so callers can tick it locally.
 */
export function pomodoroRemaining(
  pomo: PomodoroState,
  now: number = Date.now(),
): number {
  if (pomo.phase === "idle" || !pomo.startedAt) return 0;
  const started = Date.parse(pomo.startedAt);
  if (Number.isNaN(started)) return 0;
  const elapsed = (now - started) / 1000;
  return Math.max(0, pomo.durationSec - elapsed);
}

/**
 * The phase that follows the current one when it elapses (or is skipped):
 *   - focus → break  (and `cycle` increments — a focus block was completed)
 *   - break → focus
 *   - idle  → focus  (skip from idle just starts a focus block)
 * The returned state re-stamps `startedAt` to `nowIso` and sets `durationSec`
 * from the configured focus/break lengths, preserving `runningBy`/config.
 */
export function nextPhase(
  pomo: PomodoroState,
  nowIso: string = new Date().toISOString(),
): PomodoroState {
  const goingToBreak = pomo.phase === "focus";
  const phase: PomodoroPhase = goingToBreak ? "break" : "focus";
  return {
    ...pomo,
    phase,
    startedAt: nowIso,
    durationSec: goingToBreak ? pomo.breakSec : pomo.focusSec,
    // A completed focus block bumps the cycle count.
    cycle: goingToBreak ? pomo.cycle + 1 : pomo.cycle,
  };
}

// ---------------------------------------------------------------------------
// Pomodoro writer — any member may drive the timer.
// ---------------------------------------------------------------------------

/** Overwrite the room's pomodoro state (start / stop / skip / auto-advance). */
export async function setPomodoro(
  roomId: string,
  next: PomodoroState,
): Promise<void> {
  await updateDoc(doc(db, paths.roomDoc(roomId)), { pomodoro: next });
}

// ---------------------------------------------------------------------------
// Leave — a member removes themselves from the room's members array.
// ---------------------------------------------------------------------------

/** Remove `uid` from the room's `members` (the rules allow self-removal). */
export async function leaveRoom(roomId: string, uid: string): Promise<void> {
  await updateDoc(doc(db, paths.roomDoc(roomId)), {
    members: arrayRemove(uid),
  });
}

// ---------------------------------------------------------------------------
// My rooms — live list of rooms I'm a member of.
// ---------------------------------------------------------------------------

export interface MyRoomsState {
  rooms: Room[];
  loading: boolean;
  error: boolean;
}

/**
 * Live `onSnapshot` of `rooms where members array-contains uid`, newest first.
 * A live subscription (not a one-shot query) so a freshly created/joined room
 * appears immediately and the "N focusing" badge stays current. No-op (empty)
 * while signed out.
 */
export function useMyRooms(): MyRoomsState {
  const { user } = useAuth();
  const uid = user?.uid;

  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!uid) {
      setRooms([]);
      setLoading(false);
      setError(false);
      return;
    }
    setLoading(true);
    setError(false);

    const q = query(
      collection(db, paths.rooms()),
      where("members", "array-contains", uid),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => d.data() as Room);
        // Newest first (ISO timestamps sort lexicographically).
        list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setRooms(list);
        setLoading(false);
        setError(false);
      },
      () => {
        setError(true);
        setLoading(false);
      },
    );
    return unsub;
  }, [uid]);

  return { rooms, loading, error };
}

// ---------------------------------------------------------------------------
// A single room — LIVE, so the pomodoro + members update for everyone at once.
// ---------------------------------------------------------------------------

export interface RoomState {
  room: Room | null;
  loading: boolean;
  /** True once the live read resolves to "no room" — not-found OR not a member
   *  (a non-member's read is permission-denied, which we treat the same way). */
  missing: boolean;
}

/**
 * Live `onSnapshot(roomDoc)`. Returns `room` while it exists and you can read
 * it; `missing` once it resolves to nothing — either the room doesn't exist or
 * you're not a member (the rules deny the read, which surfaces as an error here
 * and is indistinguishable from, and handled identically to, not-found).
 */
export function useRoom(roomId: string | undefined): RoomState {
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!roomId) {
      setRoom(null);
      setLoading(false);
      setMissing(true);
      return;
    }
    setLoading(true);
    setMissing(false);

    const unsub = onSnapshot(
      doc(db, paths.roomDoc(roomId)),
      (snap) => {
        if (snap.exists()) {
          setRoom(snap.data() as Room);
          setMissing(false);
        } else {
          setRoom(null);
          setMissing(true);
        }
        setLoading(false);
      },
      // Permission-denied (not a member) or any read error → treat as missing.
      () => {
        setRoom(null);
        setMissing(true);
        setLoading(false);
      },
    );
    return unsub;
  }, [roomId]);

  return { room, loading, missing };
}

// ---------------------------------------------------------------------------
// Messages — live, ordered, capped; plus a sender.
// ---------------------------------------------------------------------------

export interface RoomMessagesState {
  messages: RoomMessage[];
  loading: boolean;
  error: boolean;
}

/**
 * Live feed of a room's messages, oldest→newest, capped at the most recent
 * MESSAGE_CAP. Firestore's `limit` keeps the newest, so we query DESC + reverse
 * for chronological display.
 */
export function useRoomMessages(roomId: string | undefined): RoomMessagesState {
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!roomId) {
      setMessages([]);
      setLoading(false);
      setError(false);
      return;
    }
    setLoading(true);
    setError(false);

    const q = query(
      collection(db, paths.roomMessages(roomId)),
      orderBy("createdAt", "desc"),
      limit(MESSAGE_CAP),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => d.data() as RoomMessage);
        // Query is newest-first (so `limit` keeps the latest); flip to oldest-first.
        list.reverse();
        setMessages(list);
        setLoading(false);
        setError(false);
      },
      () => {
        setError(true);
        setLoading(false);
      },
    );
    return unsub;
  }, [roomId]);

  return { messages, loading, error };
}

/**
 * Append a chat message authored by the signed-in member, with their display
 * name denormalised so the feed renders without a profile read. Trims the text
 * and no-ops on an empty body or while signed out. The id is the new doc's id
 * (set after creation) so it matches the path.
 */
export async function sendMessage(
  roomId: string,
  uid: string,
  name: string | null,
  text: string,
): Promise<void> {
  const body = text.trim();
  if (!body) return;
  const col = collection(db, paths.roomMessages(roomId));
  const ref = await addDoc(col, {
    uid,
    name,
    text: body,
    createdAt: new Date().toISOString(),
  });
  // Backfill the denormalised id so the doc matches `roomMessageDoc(roomId, id)`.
  await setDoc(ref, { id: ref.id }, { merge: true });
}

// ---------------------------------------------------------------------------
// Presence — heartbeat writer + live reader, scoped to one room.
// ---------------------------------------------------------------------------

/** A member's live room presence as the reader sees it. */
export interface LiveRoomPresence {
  uid: string;
  online: boolean;
  /** Their pomodoro status while here ("focusing" during a focus block). */
  status: string;
  activity: string | null;
}

/** Is an ISO `lastSeen` recent enough to count as in-the-room "online"? */
function roomOnline(lastSeen: string | null | undefined, now: number): boolean {
  if (!lastSeen) return false;
  const t = Date.parse(lastSeen);
  if (Number.isNaN(t)) return false;
  return Math.abs(now - t) < ROOM_FRESH_MS;
}

/**
 * While mounted in a room, write the signed-in member's presence doc on mount,
 * whenever `status` changes, every ROOM_HEARTBEAT_MS, and when the tab returns
 * to the foreground. We never write an explicit "offline" — leaving the room
 * (unmount) just stops the beat, and the dot fades once ROOM_FRESH_MS lapses.
 * Fire-and-forget: a failed beat self-corrects on the next one.
 */
export function useRoomPresenceHeartbeat(
  roomId: string | undefined,
  status: string,
): void {
  const { user } = useAuth();
  const uid = user?.uid;

  useEffect(() => {
    if (!roomId || !uid) return;
    const ref = doc(db, paths.roomPresenceDoc(roomId, uid));

    const beat = (): void => {
      void setDoc(ref, {
        uid,
        status,
        activity: null,
        lastSeen: new Date().toISOString(),
      }).catch(() => {});
    };

    beat(); // announce immediately on mount / status change.
    const interval = window.setInterval(beat, ROOM_HEARTBEAT_MS);

    const onVisible = (): void => {
      if (document.visibilityState === "visible") beat();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [roomId, uid, status]);
}

/**
 * Live read of every member's presence in a room, keyed by uid. Online is
 * recomputed on each snapshot AND on a steady tick (so a member who simply goes
 * quiet fades to offline once ROOM_FRESH_MS lapses, even without a new event).
 * Cleans up the subscription + tick on unmount / room change.
 */
export function useRoomPresence(
  roomId: string | undefined,
): Record<string, LiveRoomPresence> {
  // Raw presence docs as last seen on the wire, keyed by uid.
  const [raw, setRaw] = useState<
    Record<string, { uid: string; status: string; activity: string | null; lastSeen: string }>
  >({});
  // A ticking clock so freshness re-evaluates without a new snapshot.
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!roomId) {
      setRaw({});
      return;
    }
    setRaw({});

    const unsub = onSnapshot(
      collection(db, paths.roomPresence(roomId)),
      (snap) => {
        const next: Record<
          string,
          { uid: string; status: string; activity: string | null; lastSeen: string }
        > = {};
        for (const d of snap.docs) {
          const p = d.data() as {
            uid?: string;
            status?: string;
            activity?: string | null;
            lastSeen?: string;
          };
          const id = p.uid ?? d.id;
          next[id] = {
            uid: id,
            status: p.status ?? "online",
            activity: p.activity ?? null,
            lastSeen: p.lastSeen ?? "",
          };
        }
        setRaw(next);
      },
      // Drop presence on a read error rather than tearing the room down.
      () => setRaw({}),
    );

    const interval = window.setInterval(() => setNow(Date.now()), ROOM_HEARTBEAT_MS);

    return () => {
      unsub();
      window.clearInterval(interval);
    };
  }, [roomId]);

  return useMemo(() => {
    const out: Record<string, LiveRoomPresence> = {};
    for (const [id, p] of Object.entries(raw)) {
      out[id] = {
        uid: id,
        online: roomOnline(p.lastSeen, now),
        status: p.status,
        activity: p.activity,
      };
    }
    return out;
  }, [raw, now]);
}

// ---------------------------------------------------------------------------
// Member display names — read each member's public profile (cached).
// ---------------------------------------------------------------------------

/**
 * Resolve member uids → display name / photo via their public profiles, one
 * cached react-query per uid (profiles are signed-in-readable). Returns a map
 * `{ [uid]: { displayName, photoURL } }`; uids still loading or without a
 * profile are simply absent (callers fall back to a denormalised name / "Member").
 */
export function useMemberProfiles(
  uids: string[],
): Record<string, { displayName: string | null; photoURL: string | null }> {
  // Stable, de-duplicated, sorted list so equivalent arrays don't thrash.
  const ids = useMemo(
    () => Array.from(new Set(uids)).sort(),
    [uids],
  );

  const results = useQueries({
    queries: ids.map((uid) => ({
      queryKey: ["roomMemberProfile", uid] as const,
      // Profiles are stable for a session; no need to refetch on focus.
      staleTime: 5 * 60 * 1000,
      queryFn: async (): Promise<PublicProfile | null> => {
        const snap = await getDoc(doc(db, paths.profileDoc(uid)));
        return snap.exists() ? (snap.data() as PublicProfile) : null;
      },
    })),
  });

  return useMemo(() => {
    const out: Record<string, { displayName: string | null; photoURL: string | null }> = {};
    ids.forEach((uid, i) => {
      const data = results[i]?.data;
      if (data) out[uid] = { displayName: data.displayName, photoURL: data.photoURL };
    });
    return out;
  }, [ids, results]);
}
