/**
 * Read/write the learner's study-preferences doc (`users/{uid}/prefs/summary`),
 * which today holds per-subject exam dates that drive the readiness countdown.
 * Unlike `concepts`/`mastery` (Cloud-Function-owned, read-only on the client),
 * this doc is client-written — the security rules allow the owner to read and
 * write their own prefs.
 *
 * Reads go through react-query (`useExamPrefs`) so the panel stays in sync;
 * writes invalidate that cache so a freshly set/cleared date shows immediately.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteField, doc, getDoc, setDoc } from "firebase/firestore";
import { EMPTY_EXAM_PREFS, paths, type ExamPrefs } from "@tutor/shared";
import { db } from "./firebase";
import { useAuth } from "./auth";

/** react-query key for the prefs doc, scoped per user. */
export const examPrefsKey = (uid: string) => ["examPrefs", uid] as const;

/** The signed-in user's exam prefs, falling back to an empty map. */
export function useExamPrefs() {
  const { user } = useAuth();
  const uid = user?.uid;
  return useQuery({
    queryKey: examPrefsKey(uid ?? "anon"),
    enabled: !!uid,
    queryFn: async (): Promise<ExamPrefs> => {
      const snap = await getDoc(doc(db, paths.prefsDoc(uid!)));
      if (!snap.exists()) return EMPTY_EXAM_PREFS;
      const data = snap.data() as Partial<ExamPrefs> | undefined;
      // Be defensive: the doc may exist with unrelated prefs and no examDates.
      return { examDates: data?.examDates ?? {} };
    },
  });
}

/**
 * Set one subject's exam date (ISO `yyyy-mm-dd`).
 *
 * A merge-write of a *nested* map merges keys rather than replacing the whole
 * `examDates` object — Firestore deep-merges plain maps under `{ merge: true }`,
 * so every other subject's date survives untouched. (Arrays and nested docs are
 * the cases that get *replaced*; a plain string→string map like this one does
 * not.) Only the targeted key is written.
 */
export async function setExamDate(uid: string, subject: string, isoDate: string): Promise<void> {
  await setDoc(
    doc(db, paths.prefsDoc(uid)),
    { examDates: { [subject]: isoDate } },
    { merge: true },
  );
}

/**
 * Remove one subject's exam date. We can't "merge away" a key by writing
 * `undefined`, so we use Firestore's `deleteField()` sentinel — it deletes just
 * `examDates.<subject>` and leaves the rest of the map (and doc) intact.
 */
export async function clearExamDate(uid: string, subject: string): Promise<void> {
  await setDoc(
    doc(db, paths.prefsDoc(uid)),
    { examDates: { [subject]: deleteField() } },
    { merge: true },
  );
}

/** Returns a callback that re-fetches the prefs doc so the UI reflects writes. */
export function useInvalidateExamPrefs() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const uid = user?.uid ?? "anon";
  return () => qc.invalidateQueries({ queryKey: examPrefsKey(uid) });
}

/**
 * Convenience mutation hook: set or clear a subject's exam date and invalidate
 * the prefs cache on success so `useExamPrefs` re-reads and the panel updates
 * live. Pass `isoDate: null` to clear.
 */
export function useSetExamDate() {
  const { user } = useAuth();
  const invalidate = useInvalidateExamPrefs();
  return useMutation({
    mutationFn: async ({ subject, isoDate }: { subject: string; isoDate: string | null }) => {
      const uid = user?.uid;
      if (!uid) throw new Error("Not signed in.");
      if (isoDate) await setExamDate(uid, subject, isoDate);
      else await clearExamDate(uid, subject);
    },
    onSuccess: () => invalidate(),
  });
}
