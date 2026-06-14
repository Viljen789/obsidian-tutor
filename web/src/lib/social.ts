/**
 * Collaboration data layer (Wave 5): the signed-in learner's public profile,
 * their friends, and incoming friend requests — wrapped in react-query.
 *
 * Split of responsibilities, mirroring CONTRACTS.md:
 *   - WRITES go through the `api` callables (ensureProfile / sendFriendRequest /
 *     respondFriendRequest / removeFriend). The server owns the source of truth:
 *     it mints the friendCode, writes friendships to BOTH sides, and can't be
 *     forged. The client never mutates profiles / friends / requests directly.
 *   - READS come straight from Firestore (the rules allow the owner to read
 *     their own friends list, and sender/recipient to read a request).
 *
 * `ensureProfile` is idempotent, so `useProfile` calls it as the query function
 * and caches the result (with a long staleTime) — one call per session is
 * plenty to mint/refresh the code. Query keys are centralised in `socialKeys`
 * so accepting a request can invalidate friends + requests together via
 * `useInvalidateSocial`, and the UI reflects the new state immediately.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { collection, getDocs, query, where } from "firebase/firestore";
import type { Friend, FriendRequest, PublicProfile } from "@tutor/shared";
import { paths } from "@tutor/shared";
import { api } from "./api";
import { db } from "./firebase";
import { useAuth } from "./auth";

// ---------------------------------------------------------------------------
// Query keys — one home so readers and invalidators agree.
// ---------------------------------------------------------------------------

export const socialKeys = {
  profile: (uid: string) => ["profile", uid] as const,
  friends: (uid: string) => ["friends", uid] as const,
  requests: (uid: string) => ["friendRequests", uid] as const,
};

// ---------------------------------------------------------------------------
// Profile — calls the idempotent ensureProfile callable and caches it.
// ---------------------------------------------------------------------------

/**
 * The caller's public profile (uid / displayName / photoURL / friendCode).
 * Backed by `api.ensureProfile({})`, which creates the profile and mints a
 * friendCode on first call and is a no-op refresh thereafter — so running it as
 * the query function is safe. Cached with a long staleTime since the code is
 * stable for the session. Disabled until signed in.
 */
export function useProfile() {
  const { user } = useAuth();
  const uid = user?.uid;
  return useQuery({
    queryKey: socialKeys.profile(uid ?? "anon"),
    enabled: !!uid,
    // The code is stable; no need to re-mint on every focus/mount.
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<PublicProfile> => api.ensureProfile({}),
  });
}

// ---------------------------------------------------------------------------
// Friends — read the owner's friends subcollection.
// ---------------------------------------------------------------------------

/** The signed-in learner's friends, most-recently-added first. */
export function useFriends() {
  const { user } = useAuth();
  const uid = user?.uid;
  return useQuery({
    queryKey: socialKeys.friends(uid ?? "anon"),
    enabled: !!uid,
    queryFn: async (): Promise<Friend[]> => {
      const snap = await getDocs(collection(db, paths.friends(uid!)));
      const list = snap.docs.map((d) => d.data() as Friend);
      // Newest friendships first (ISO timestamps sort lexicographically).
      list.sort((a, b) => b.since.localeCompare(a.since));
      return list;
    },
  });
}

// ---------------------------------------------------------------------------
// Incoming requests — pending requests addressed to me.
// ---------------------------------------------------------------------------

/**
 * Pending friend requests where I'm the recipient. Each carries denormalised
 * sender info (fromName / fromPhoto) so the list renders without extra reads.
 */
export function useFriendRequests() {
  const { user } = useAuth();
  const uid = user?.uid;
  return useQuery({
    queryKey: socialKeys.requests(uid ?? "anon"),
    enabled: !!uid,
    queryFn: async (): Promise<FriendRequest[]> => {
      const q = query(
        collection(db, paths.friendRequests()),
        where("toUid", "==", uid!),
        where("status", "==", "pending"),
      );
      const snap = await getDocs(q);
      const list = snap.docs.map((d) => d.data() as FriendRequest);
      // Newest requests first.
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return list;
    },
  });
}

// ---------------------------------------------------------------------------
// Invalidation — refresh friends + requests after responding to a request.
// ---------------------------------------------------------------------------

/**
 * Returns a callback that invalidates the friends and requests caches together.
 * Accepting a request flips it out of "pending" AND adds a friend server-side,
 * so both lists need a refetch; `refreshAll` covers that in one call. The
 * optional args let a caller invalidate just one when that's all that changed.
 */
export function useInvalidateSocial() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const uid = user?.uid ?? "anon";

  const invalidateFriends = () =>
    qc.invalidateQueries({ queryKey: socialKeys.friends(uid) });
  const invalidateRequests = () =>
    qc.invalidateQueries({ queryKey: socialKeys.requests(uid) });

  return {
    invalidateFriends,
    invalidateRequests,
    /** Invalidate both friends and requests (the accept-a-request case). */
    refreshAll: () => {
      void invalidateFriends();
      void invalidateRequests();
    },
  };
}
