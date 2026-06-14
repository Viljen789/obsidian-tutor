/**
 * Learner-model settings (the three sequencer knobs from CONTRACTS.md).
 *
 * Settings live as a nested `settings` field on the user PROFILE doc at
 * `users/{uid}` — the same doc that holds uid/displayName/email/createdAt. So
 * every write MUST use `{ merge: true }` to avoid clobbering the profile, and
 * every read merges over DEFAULT_USER_SETTINGS exactly the way the Cloud
 * Function `getSettings` (functions/src/lib/firebase.ts) does, so client and
 * server always agree on the effective values — including for users whose doc
 * predates one of the fields.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { DEFAULT_USER_SETTINGS, paths, type UserSettings } from "@tutor/shared";
import { db } from "./firebase";
import { useAuth } from "./auth";

export const settingsKey = (uid: string) => ["settings", uid] as const;

/** Reads the user's effective settings (defaults filled in for missing fields). */
export function useSettings() {
  const { user } = useAuth();
  const uid = user?.uid;
  return useQuery({
    queryKey: settingsKey(uid ?? "anon"),
    enabled: !!uid,
    queryFn: async (): Promise<UserSettings> => readSettings(uid!),
  });
}

async function readSettings(uid: string): Promise<UserSettings> {
  const snap = await getDoc(doc(db, paths.user(uid)));
  const data = snap.data();
  // Mirror functions/src/lib/firebase.ts getSettings: defaults first, then the
  // stored partial on top, so unknown/missing fields fall back to the contract.
  return { ...DEFAULT_USER_SETTINGS, ...((data?.settings as Partial<UserSettings>) ?? {}) };
}

/**
 * Persists a partial settings update. Reads the current effective settings,
 * applies the patch, clamps to valid ranges, and writes the whole `settings`
 * object back with merge — so the surrounding profile fields are preserved.
 * Returns the saved (clamped) settings so callers can sync their local state.
 */
export async function saveSettings(
  uid: string,
  partial: Partial<UserSettings>,
): Promise<UserSettings> {
  const current = await readSettings(uid);
  const next = clampSettings({ ...current, ...partial });
  await setDoc(doc(db, paths.user(uid)), { settings: next }, { merge: true });
  return next;
}

/** Keep every knob inside the bounds the sequencer expects. */
export function clampSettings(s: UserSettings): UserSettings {
  return {
    masteryThreshold: clamp01(s.masteryThreshold),
    masteredThreshold: clamp01(s.masteredThreshold),
    // Whole, non-negative count of new concepts per day.
    dailyNewLimit: Math.max(0, Math.round(Number.isFinite(s.dailyNewLimit) ? s.dailyNewLimit : 0)),
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Convenience hook for invalidating the settings cache after a save. */
export function useInvalidateSettings() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const uid = user?.uid ?? "anon";
  return () => qc.invalidateQueries({ queryKey: settingsKey(uid) });
}
