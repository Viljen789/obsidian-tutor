/**
 * Live presence (Wave 5): a tiny "I'm here" heartbeat and a reader that turns
 * other people's heartbeats into a live online/offline signal.
 *
 * Model: each user owns one doc at `presence/{uid}` (owner-write, readable by
 * the owner + their friends per the rules). The doc carries a `lastSeen` ISO
 * timestamp; "online" is simply *recent* — `lastSeen` within FRESH_MS. We never
 * write an explicit "offline"; a learner who closes the tab just stops beating,
 * and their dot goes dark once the freshness window lapses. This is robust to
 * crashes and lost connections (no reliance on a clean disconnect).
 *
 * Cadence vs. freshness:
 *   - HEARTBEAT_MS (~30s): how often we re-stamp our own presence.
 *   - FRESH_MS (~70s): how long a stamp counts as "online" — a bit over 2×
 *     the cadence, so one dropped/late beat doesn't flicker us offline.
 */
import { useEffect, useMemo, useState } from "react";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import type { Presence, PresenceStatus } from "@tutor/shared";
import { paths } from "@tutor/shared";
import { db } from "./firebase";
import { useAuth } from "./auth";

/** How often we re-write our own presence doc, in ms (~30s). */
export const HEARTBEAT_MS = 30_000;

/** How long a `lastSeen` stamp counts as "online", in ms (~70s). */
export const FRESH_MS = 70_000;

/** A friend's live presence as the reader sees it. */
export interface LivePresence {
  status: PresenceStatus;
  activity: string | null;
  online: boolean;
}

// ---------------------------------------------------------------------------
// Freshness helper.
// ---------------------------------------------------------------------------

/**
 * Is an ISO `lastSeen` recent enough to be "online"? True when the stamp parses
 * and sits within FRESH_MS of `now` (also guards against clock-skewed future
 * stamps by clamping the delta to its magnitude). A malformed/empty stamp is
 * treated as offline.
 */
export function isOnline(lastSeen: string | null | undefined, now: number = Date.now()): boolean {
  if (!lastSeen) return false;
  const t = Date.parse(lastSeen);
  if (Number.isNaN(t)) return false;
  return Math.abs(now - t) < FRESH_MS;
}

// ---------------------------------------------------------------------------
// Heartbeat writer — mounted ONCE at app level by the orchestrator.
// ---------------------------------------------------------------------------

/**
 * Writes the signed-in learner's presence doc on mount, then every
 * HEARTBEAT_MS, and again whenever the tab becomes visible (so returning to a
 * backgrounded tab refreshes the dot immediately). No-op while signed out, and
 * fully cleaned up on unmount or sign-out. Fire-and-forget: a failed beat is
 * swallowed (the next beat, or the freshness lapse, self-corrects).
 *
 * `activity` defaults to null for now — enrichment (what they're studying) can
 * come later without changing the doc shape.
 */
export function usePresenceHeartbeat(): void {
  const { user } = useAuth();
  const uid = user?.uid;

  useEffect(() => {
    if (!uid) return; // signed out — nothing to broadcast.

    const ref = doc(db, paths.presenceDoc(uid));

    const beat = (): void => {
      const payload: Presence = {
        uid,
        status: "online",
        activity: null,
        lastSeen: new Date().toISOString(),
      };
      // Fire-and-forget; the next beat (or freshness lapse) self-corrects.
      void setDoc(ref, payload).catch(() => {});
    };

    beat(); // announce immediately on mount / sign-in.
    const interval = window.setInterval(beat, HEARTBEAT_MS);

    // Re-beat when the tab comes back to the foreground.
    const onVisible = (): void => {
      if (document.visibilityState === "visible") beat();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [uid]);
}

// ---------------------------------------------------------------------------
// Reader — live presence for a set of uids.
// ---------------------------------------------------------------------------

/**
 * Subscribes to each given uid's presence doc and returns a live map
 * `{ [uid]: { status, activity, online } }`. Online is recomputed both on every
 * snapshot AND on a steady tick (every HEARTBEAT_MS), so a friend who simply
 * goes quiet fades to offline once FRESH_MS lapses — even without a new
 * snapshot event. uids absent from the map (or never seen) are treated as
 * offline by callers.
 *
 * The uid list is sorted+joined into a stable dependency key so re-renders with
 * an equivalent (but new-reference) array don't tear down and re-open the
 * subscriptions.
 */
export function usePresence(uids: string[]): Record<string, LivePresence> {
  // Stable key so [a,b] and a fresh [a,b] don't thrash the effect.
  const key = useMemo(() => [...uids].sort().join(","), [uids]);

  // Raw docs as last seen on the wire, keyed by uid.
  const [raw, setRaw] = useState<Record<string, Presence>>({});
  // A ticking clock so freshness re-evaluates without a new snapshot.
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) {
      setRaw({});
      return;
    }

    const unsubs = ids.map((id) =>
      onSnapshot(
        doc(db, paths.presenceDoc(id)),
        (snap) => {
          setRaw((prev) => {
            const next = { ...prev };
            if (snap.exists()) {
              next[id] = snap.data() as Presence;
            } else {
              delete next[id];
            }
            return next;
          });
        },
        // On a per-doc error (e.g. a transient rules/permission hiccup), drop
        // that uid rather than tearing down the whole reader.
        () => {
          setRaw((prev) => {
            if (!(id in prev)) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          });
        },
      ),
    );

    // Re-tick the clock so "online" decays to offline between snapshots.
    const interval = window.setInterval(() => setNow(Date.now()), HEARTBEAT_MS);

    return () => {
      unsubs.forEach((u) => u());
      window.clearInterval(interval);
    };
  }, [key]);

  // Derive the live view from the raw docs + the current clock.
  return useMemo(() => {
    const out: Record<string, LivePresence> = {};
    for (const [id, p] of Object.entries(raw)) {
      const online = isOnline(p.lastSeen, now);
      out[id] = {
        status: p.status,
        activity: p.activity,
        online,
      };
    }
    return out;
  }, [raw, now]);
}
