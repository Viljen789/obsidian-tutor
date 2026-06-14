/**
 * Practice-exam history (Wave 2). A thin client-side store for `ExamRecord`s —
 * one document per sat exam under `users/{uid}/exams/{examId}`.
 *
 * Unlike `concepts`/`mastery` (written only by Cloud Functions), exam records
 * are written directly by the client when a paper is marked; the Firestore
 * rules allow the owner to read and write their own `exams` subcollection. We
 * therefore keep both the write (`saveExamRecord`) and the read
 * (`useExamHistory`, react-query) here, alongside the other Firestore helpers.
 *
 * The list is sorted client-side by `takenAt` descending so the most recent
 * paper leads — no Firestore index or ordered query needed.
 */
import { useQuery } from "@tanstack/react-query";
import { collection, doc, getDocs, setDoc } from "firebase/firestore";
import type { ExamRecord } from "@tutor/shared";
import { paths } from "@tutor/shared";
import { db } from "./firebase";
import { useAuth } from "./auth";

/** react-query key for a user's exam history. */
export const examHistoryKey = (uid: string) => ["examHistory", uid] as const;

/**
 * Persist one sat exam. Writes to `users/{uid}/exams/{record.id}`. Callers
 * should treat this as best-effort — a failure here must never block showing
 * the marked report (wrap the call in try/catch at the call site).
 */
export async function saveExamRecord(uid: string, record: ExamRecord): Promise<void> {
  await setDoc(doc(db, paths.examDoc(uid, record.id)), record);
}

/**
 * All exam records for the signed-in user, newest first. Mirrors the read
 * pattern of `useConcepts`/`useMastery`: a direct `getDocs` over the
 * subcollection, sorted on the client by `takenAt` descending.
 */
export function useExamHistory() {
  const { user } = useAuth();
  const uid = user?.uid;
  return useQuery({
    queryKey: examHistoryKey(uid ?? "anon"),
    enabled: !!uid,
    queryFn: async (): Promise<ExamRecord[]> => {
      const snap = await getDocs(collection(db, paths.exams(uid!)));
      const list = snap.docs.map((d) => d.data() as ExamRecord);
      list.sort((a, b) => Date.parse(b.takenAt) - Date.parse(a.takenAt));
      return list;
    },
  });
}
