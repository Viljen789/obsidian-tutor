/**
 * deleteSubject — removes an imported subject and everything tied to it
 * (concepts, mastery, cached explanations). Server-side + auth-scoped so a user
 * can only ever clear their own data. (Backend agent fills the body.)
 */
import type { DeleteSubjectRequest, DeleteSubjectResponse } from "@tutor/shared";
import { authedCallable, HttpsError } from "../lib/callable";
import { deleteSubjectData } from "../lib/firebase";

export const deleteSubject = authedCallable<DeleteSubjectRequest, DeleteSubjectResponse>(
  {},
  async (data, { uid }) => {
    const subject = data.subject?.trim();
    if (!subject) {
      throw new HttpsError("invalid-argument", "A non-empty subject is required.");
    }
    const deletedConcepts = await deleteSubjectData(uid, subject);
    return { subject, deletedConcepts };
  },
);
