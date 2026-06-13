/**
 * Read-only Firestore access for the learner-facing collections, wrapped in
 * react-query. Per CONTRACTS.md §2, `concepts` and `mastery` are written only
 * by Cloud Functions — the client reads them directly (allowed by the rules)
 * but never mutates them. All mutations go through the `api` callables.
 *
 * Query keys are centralised in `qk` so the Q&A loop can invalidate mastery the
 * moment an answer is graded, and the UI reflects the new learner state live.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { collection, doc, getDoc, getDocs } from "firebase/firestore";
import type { Concept, Mastery } from "@tutor/shared";
import { paths } from "@tutor/shared";
import { db } from "./firebase";
import { useAuth } from "./auth";

export const qk = {
  concepts: (uid: string) => ["concepts", uid] as const,
  concept: (uid: string, id: string) => ["concept", uid, id] as const,
  mastery: (uid: string) => ["mastery", uid] as const,
  masteryDoc: (uid: string, id: string) => ["masteryDoc", uid, id] as const,
};

/** All concepts for the signed-in user, sorted by subject then title. */
export function useConcepts() {
  const { user } = useAuth();
  const uid = user?.uid;
  return useQuery({
    queryKey: qk.concepts(uid ?? "anon"),
    enabled: !!uid,
    queryFn: async (): Promise<Concept[]> => {
      const snap = await getDocs(collection(db, paths.concepts(uid!)));
      const list = snap.docs.map((d) => d.data() as Concept);
      list.sort(
        (a, b) =>
          a.subject.localeCompare(b.subject) || a.title.localeCompare(b.title),
      );
      return list;
    },
  });
}

/** A single concept document (used for nicer titles on the Learn/Review views). */
export function useConcept(conceptId: string | null | undefined) {
  const { user } = useAuth();
  const uid = user?.uid;
  return useQuery({
    queryKey: qk.concept(uid ?? "anon", conceptId ?? "none"),
    enabled: !!uid && !!conceptId,
    queryFn: async (): Promise<Concept | null> => {
      const ref = doc(db, paths.concept(uid!, conceptId!));
      const snap = await getDoc(ref);
      return snap.exists() ? (snap.data() as Concept) : null;
    },
  });
}

/** All mastery records, keyed by conceptId for easy joins with concepts. */
export function useMastery() {
  const { user } = useAuth();
  const uid = user?.uid;
  return useQuery({
    queryKey: qk.mastery(uid ?? "anon"),
    enabled: !!uid,
    queryFn: async (): Promise<Record<string, Mastery>> => {
      const snap = await getDocs(collection(db, paths.mastery(uid!)));
      const byId: Record<string, Mastery> = {};
      for (const d of snap.docs) {
        const m = d.data() as Mastery;
        byId[m.conceptId] = m;
      }
      return byId;
    },
  });
}

/**
 * Returns a callback that invalidates the cached mastery (and a specific
 * concept's mastery doc) so freshly graded state is re-fetched. The backend is
 * the source of truth, so we refetch rather than optimistically patch.
 */
export function useInvalidateMastery() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const uid = user?.uid ?? "anon";
  return (conceptId?: string) => {
    void qc.invalidateQueries({ queryKey: qk.mastery(uid) });
    if (conceptId)
      void qc.invalidateQueries({ queryKey: qk.masteryDoc(uid, conceptId) });
  };
}
