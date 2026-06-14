/**
 * Subject-sharing data layer (Wave 5b): the signed-in learner's inbox of decks
 * friends have shared, plus the share / import / dismiss mutations.
 *
 * Split of responsibilities, mirroring lib/social:
 *   - WRITES go through the `api` callables. shareSubjectToFriend snapshots a
 *     subject and drops it in the friend's inbox; importSharedDeck copies a deck
 *     into the importer's OWN vault (fresh concepts, their own mastery from
 *     zero). The client never writes a share/inbox item directly — except the
 *     one delete it's allowed: clearing its own inbox.
 *   - The INBOX is read straight from Firestore (the rules let the owner read
 *     their own inbox). It's a LIVE subscription (onSnapshot) bridged into the
 *     react-query cache so a freshly-shared deck appears without a refresh and
 *     an imported/dismissed one disappears at once.
 *
 * After a successful import we both delete the inbox item (it's been consumed)
 * and invalidate the importer's concepts + mastery so the new subject shows up
 * across the app immediately.
 */
import { useEffect } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { collection, deleteDoc, doc, onSnapshot } from "firebase/firestore";
import type { InboxItem } from "@tutor/shared";
import { paths } from "@tutor/shared";
import { api } from "./api";
import { db } from "./firebase";
import { useAuth } from "./auth";
import { qk } from "./firestore-hooks";

// ---------------------------------------------------------------------------
// Query keys — one home so the reader and the live bridge agree.
// ---------------------------------------------------------------------------

export const sharingKeys = {
  inbox: (uid: string) => ["inbox", uid] as const,
};

// ---------------------------------------------------------------------------
// Inbox — a LIVE read of the owner's incoming shared decks.
// ---------------------------------------------------------------------------

/**
 * The signed-in learner's inbox (decks friends have shared), newest first.
 *
 * Backed by react-query for caching/loading/error ergonomics, but kept LIVE by
 * an onSnapshot subscription that writes each update into the query cache — so
 * the list reflects a new share, an import, or a dismiss the moment it lands,
 * with no manual refetch. Disabled (and the subscription is a no-op) while
 * signed out.
 */
export function useInbox() {
  const { user } = useAuth();
  const uid = user?.uid;
  const qc = useQueryClient();

  // Bridge the Firestore subscription into the react-query cache. The query's
  // own queryFn never runs to the network (the snapshot is the source of truth);
  // it just hands back whatever the subscription has populated.
  useEffect(() => {
    if (!uid) return;
    const unsub = onSnapshot(
      collection(db, paths.inbox(uid)),
      (snap) => {
        const list = snap.docs.map((d) => d.data() as InboxItem);
        // Newest first (ISO timestamps sort lexicographically).
        list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        qc.setQueryData(sharingKeys.inbox(uid), list);
      },
      // A transient rules/permission hiccup shouldn't wedge the UI — fall back
      // to an empty inbox rather than a hard error.
      () => qc.setQueryData(sharingKeys.inbox(uid), []),
    );
    return unsub;
  }, [uid, qc]);

  return useQuery({
    queryKey: sharingKeys.inbox(uid ?? "anon"),
    enabled: !!uid,
    // The onSnapshot bridge keeps this fresh; never refetch on the network.
    staleTime: Infinity,
    queryFn: (): InboxItem[] =>
      qc.getQueryData<InboxItem[]>(sharingKeys.inbox(uid ?? "anon")) ?? [],
  });
}

// ---------------------------------------------------------------------------
// Share — snapshot a subject and drop it in a friend's inbox.
// ---------------------------------------------------------------------------

/** Share a subject with a friend by uid. Returns { ok, shareId }. */
export function useShareSubject() {
  return useMutation({
    mutationFn: (vars: { subject: string; toUid: string }) =>
      api.shareSubjectToFriend(vars),
  });
}

// ---------------------------------------------------------------------------
// Import — copy a shared deck into MY vault, then clear the inbox item.
// ---------------------------------------------------------------------------

/**
 * Import a shared deck into the signed-in learner's own vault. On success:
 *   1. delete the consumed inbox item (the client owns its own inbox), and
 *   2. invalidate concepts + mastery so the new subject appears app-wide.
 *
 * Takes both the `shareId` (what to import) and the inbox `itemId` (what to
 * clear afterwards); the backend only needs the shareId.
 */
export function useImportDeck() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const uid = user?.uid;

  return useMutation({
    mutationFn: async (vars: { shareId: string; itemId: string }) => {
      const res = await api.importSharedDeck({ shareId: vars.shareId });
      // Clear the consumed inbox item. Best-effort: the import already
      // succeeded, so a failed delete shouldn't surface as an import error —
      // the live subscription will drop it on the next successful read anyway.
      if (uid) {
        await deleteDoc(doc(db, paths.inboxDoc(uid, vars.itemId))).catch(() => {});
      }
      return res;
    },
    onSuccess: () => {
      if (!uid) return;
      void qc.invalidateQueries({ queryKey: qk.concepts(uid) });
      void qc.invalidateQueries({ queryKey: qk.mastery(uid) });
    },
  });
}

// ---------------------------------------------------------------------------
// Dismiss — drop an inbox item without importing it.
// ---------------------------------------------------------------------------

/** Dismiss (delete) an inbox item by id. The owner may clear their own inbox. */
export function useDismissInbox() {
  const { user } = useAuth();
  const uid = user?.uid;

  return useMutation({
    mutationFn: async (itemId: string) => {
      if (!uid) return;
      await deleteDoc(doc(db, paths.inboxDoc(uid, itemId)));
    },
  });
}
