/**
 * Friends — the collaboration home. Four quiet sections, top to bottom:
 *
 *   1. Your profile + friend code (with copy + a ready-to-paste invite line).
 *   2. Add a friend by code → api.sendFriendRequest, with inline feedback.
 *   3. Incoming requests → Accept / Decline (api.respondFriendRequest), then
 *      invalidate friends + requests so both lists update at once.
 *   4. Your friends, each with a LIVE presence dot (green when online, via
 *      usePresence) + a status label, and a quiet Remove affordance.
 *
 * All writes go through the `api` callables (the server owns the truth); the
 * lists are read via react-query hooks in lib/social, and presence is a live
 * Firestore subscription in lib/presence. The reading-room vocabulary from
 * components/ui keeps this visually of a piece with the rest of the app.
 */
import { useMemo, useState } from "react";
import { clsx } from "clsx";
import {
  Check,
  Circle,
  Copy,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import type { Friend, FriendRequest } from "@tutor/shared";
import { api } from "../lib/api";
import {
  useFriendRequests,
  useFriends,
  useInvalidateSocial,
  useProfile,
} from "../lib/social";
import { usePresence, type LivePresence } from "../lib/presence";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Eyebrow,
  Pill,
  Skeleton,
  Spinner,
} from "../components/ui";

export function Friends() {
  const profile = useProfile();
  const friends = useFriends();
  const requests = useFriendRequests();

  return (
    <div className="animate-fade space-y-7">
      <header>
        <Eyebrow tone="accent">Friends</Eyebrow>
        <h1 className="mt-1.5 font-serif text-[2rem] tracking-tight text-ink">
          Study together
        </h1>
        <p className="mt-1 max-w-lg text-[0.95rem] leading-relaxed text-muted">
          Share your code to connect, then see who's around. A green dot means a
          friend is online right now — good company makes the hard hours lighter.
        </p>
      </header>

      <ProfileCard profile={profile} />

      <AddFriend />

      <RequestsSection requests={requests} />

      <FriendsSection friends={friends} myCode={profile.data?.friendCode ?? null} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Your profile + friend code.
// ---------------------------------------------------------------------------

function ProfileCard({
  profile,
}: {
  profile: ReturnType<typeof useProfile>;
}) {
  if (profile.isLoading) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-14 w-14 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
        <Skeleton className="mt-5 h-12 w-full" />
      </Card>
    );
  }

  if (profile.isError || !profile.data) {
    return (
      <Card>
        <ErrorState
          title="Couldn't load your profile"
          description="Your friend code didn't come through. Give it another go."
          onRetry={() => void profile.refetch()}
        />
      </Card>
    );
  }

  const me = profile.data;
  return (
    <Card className="p-6">
      <div className="flex items-center gap-4">
        <Avatar
          name={me.displayName}
          photoURL={me.photoURL}
          className="h-14 w-14 text-lg"
        />
        <div className="min-w-0">
          <p className="truncate font-serif text-xl text-ink">
            {me.displayName ?? "You"}
          </p>
          <p className="mt-0.5 text-sm text-muted">This is how friends see you</p>
        </div>
      </div>

      <FriendCodeBlock code={me.friendCode} />
    </Card>
  );
}

/** The friend code shown prominently, with copy buttons for code + invite. */
function FriendCodeBlock({ code }: { code: string }) {
  const invite = `Add me on Tutor — code: ${code}`;
  const copyCode = useCopy();
  const copyInvite = useCopy();

  return (
    <div className="mt-5 rounded-xl border border-border bg-bg/40 p-4">
      <Eyebrow>Your friend code</Eyebrow>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="select-all font-serif text-2xl tracking-[0.18em] text-accent tabular-nums">
          {code}
        </span>
        <Button
          variant="secondary"
          tone="neutral"
          size="sm"
          icon={copyCode.copied ? Check : Copy}
          onClick={() => void copyCode.copy(code)}
          className="shrink-0"
        >
          {copyCode.copied ? "Copied!" : "Copy code"}
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-muted">
          {invite}
        </code>
        <Button
          variant="ghost"
          tone="accent"
          size="sm"
          icon={copyInvite.copied ? Check : Copy}
          onClick={() => void copyInvite.copy(invite)}
          className="shrink-0"
        >
          {copyInvite.copied ? "Copied!" : "Copy invite"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Add a friend by code.
// ---------------------------------------------------------------------------

type AddState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; toName: string | null }
  | { kind: "error"; message: string };

function AddFriend() {
  const [code, setCode] = useState("");
  const [state, setState] = useState<AddState>({ kind: "idle" });

  const trimmed = code.trim();
  const canSend = trimmed.length > 0 && state.kind !== "sending";

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    setState({ kind: "sending" });
    try {
      const res = await api.sendFriendRequest({ friendCode: trimmed });
      setState({ kind: "sent", toName: res.toName });
      setCode("");
    } catch (err) {
      setState({
        kind: "error",
        message:
          err instanceof Error && err.message
            ? friendlyError(err.message)
            : "Couldn't send that request. Check the code and try again.",
      });
    }
  };

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2">
        <UserPlus size={15} className="text-accent" />
        <Eyebrow tone="accent">Add a friend</Eyebrow>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Enter a friend's code to send them a request. They'll see it next time
        they open Tutor.
      </p>

      <form onSubmit={(e) => void onSubmit(e)} className="mt-4 flex flex-wrap items-center gap-2">
        <input
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            // A fresh edit clears any prior result.
            if (state.kind !== "idle" && state.kind !== "sending") {
              setState({ kind: "idle" });
            }
          }}
          placeholder="Friend code"
          aria-label="Friend code"
          autoCapitalize="characters"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-xl border border-border bg-bg/50 px-3.5 py-2.5 text-sm tracking-wide text-ink placeholder:text-muted/70 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        <Button
          type="submit"
          icon={UserPlus}
          loading={state.kind === "sending"}
          disabled={!canSend}
          className="shrink-0"
        >
          {state.kind === "sending" ? "Sending…" : "Send request"}
        </Button>
      </form>

      {state.kind === "sent" && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-accent">
          <Check size={14} />
          Request sent{state.toName ? ` to ${state.toName}` : ""}.
        </p>
      )}
      {state.kind === "error" && (
        <p className="mt-3 text-sm text-review">{state.message}</p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 3. Incoming requests.
// ---------------------------------------------------------------------------

function RequestsSection({
  requests,
}: {
  requests: ReturnType<typeof useFriendRequests>;
}) {
  // Hide the section entirely while empty — it's a transient inbox, and an empty
  // "Requests" header reads as clutter. Loading/error still surface.
  if (requests.isLoading) {
    return (
      <section>
        <SectionLabel icon={UserPlus} tone="accent">
          Requests
        </SectionLabel>
        <Card className="mt-3 p-5">
          <Spinner label="Checking for requests…" />
        </Card>
      </section>
    );
  }

  if (requests.isError) {
    return (
      <section>
        <SectionLabel icon={UserPlus} tone="accent">
          Requests
        </SectionLabel>
        <Card className="mt-3">
          <ErrorState
            title="Couldn't load requests"
            description="We couldn't fetch your incoming requests just now."
            onRetry={() => void requests.refetch()}
          />
        </Card>
      </section>
    );
  }

  const list = requests.data ?? [];
  if (list.length === 0) return null;

  return (
    <section>
      <SectionLabel icon={UserPlus} tone="accent">
        Requests
        <Pill tone="accent" className="ml-2">
          {list.length}
        </Pill>
      </SectionLabel>
      <Card className="mt-3 divide-y divide-border">
        {list.map((req) => (
          <RequestRow key={req.id} request={req} />
        ))}
      </Card>
    </section>
  );
}

function RequestRow({ request }: { request: FriendRequest }) {
  const { refreshAll } = useInvalidateSocial();
  const [busy, setBusy] = useState<null | "accept" | "decline">(null);
  const [error, setError] = useState<string | null>(null);

  const respond = async (accept: boolean) => {
    setBusy(accept ? "accept" : "decline");
    setError(null);
    try {
      await api.respondFriendRequest({ requestId: request.id, accept });
      // Accepting adds a friend AND clears the request server-side; refresh both.
      refreshAll();
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? friendlyError(err.message)
          : "Couldn't respond just now. Try again.",
      );
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Avatar name={request.fromName} photoURL={request.fromPhoto} className="h-10 w-10" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">
          {request.fromName ?? "Someone"}
        </p>
        <p className="text-xs text-muted">wants to be friends</p>
        {error && <p className="mt-1 text-xs text-review">{error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="sm"
          icon={Check}
          loading={busy === "accept"}
          disabled={busy !== null}
          onClick={() => void respond(true)}
        >
          Accept
        </Button>
        <Button
          variant="ghost"
          tone="neutral"
          size="sm"
          icon={X}
          loading={busy === "decline"}
          disabled={busy !== null}
          onClick={() => void respond(false)}
          aria-label={`Decline request from ${request.fromName ?? "this person"}`}
        >
          Decline
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Your friends + live presence.
// ---------------------------------------------------------------------------

function FriendsSection({
  friends,
  myCode,
}: {
  friends: ReturnType<typeof useFriends>;
  myCode: string | null;
}) {
  const list = useMemo(() => friends.data ?? [], [friends.data]);
  const uids = useMemo(() => list.map((f) => f.uid), [list]);
  // One live subscription for all friends at once.
  const presence = usePresence(uids);

  // Online friends float to the top; within a group, keep recency order.
  const ordered = useMemo(() => {
    return [...list].sort((a, b) => {
      const ao = presence[a.uid]?.online ? 1 : 0;
      const bo = presence[b.uid]?.online ? 1 : 0;
      return bo - ao;
    });
  }, [list, presence]);

  const onlineCount = useMemo(
    () => uids.reduce((n, uid) => n + (presence[uid]?.online ? 1 : 0), 0),
    [uids, presence],
  );

  return (
    <section>
      <SectionLabel icon={Users}>
        Friends
        {list.length > 0 && (
          <span className="ml-2 text-xs font-normal normal-case tracking-normal text-muted">
            {onlineCount > 0 ? `${onlineCount} online` : "none online"}
          </span>
        )}
      </SectionLabel>

      {friends.isLoading ? (
        <Card className="mt-3 divide-y divide-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
          ))}
        </Card>
      ) : friends.isError ? (
        <Card className="mt-3">
          <ErrorState
            title="Couldn't load your friends"
            description="Your friends list didn't come through. Give it another go."
            onRetry={() => void friends.refetch()}
          />
        </Card>
      ) : list.length === 0 ? (
        <Card className="mt-3">
          <EmptyState
            icon={Users}
            title="No friends yet"
            description={
              myCode
                ? `Share your code — ${myCode} — or send a request above to get started.`
                : "Share your friend code above, or add someone by their code to get started."
            }
          />
        </Card>
      ) : (
        <Card className="mt-3 divide-y divide-border">
          {ordered.map((friend) => (
            <FriendRow
              key={friend.uid}
              friend={friend}
              presence={presence[friend.uid]}
            />
          ))}
        </Card>
      )}
    </section>
  );
}

function FriendRow({
  friend,
  presence,
}: {
  friend: Friend;
  presence: LivePresence | undefined;
}) {
  const { invalidateFriends } = useInvalidateSocial();
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const online = presence?.online ?? false;

  const onRemove = async () => {
    setRemoving(true);
    setError(null);
    try {
      await api.removeFriend({ uid: friend.uid });
      invalidateFriends();
      // On success the row disappears with the list refresh; no need to reset.
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? friendlyError(err.message)
          : "Couldn't remove just now. Try again.",
      );
      setRemoving(false);
    }
  };

  return (
    <div className="group flex items-center gap-3 px-4 py-3">
      <div className="relative shrink-0">
        <Avatar name={friend.displayName} photoURL={friend.photoURL} className="h-10 w-10" />
        <PresenceDot online={online} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">
          {friend.displayName ?? "Friend"}
        </p>
        <p className="truncate text-xs text-muted">{statusLabel(online, presence)}</p>
        {error && <p className="mt-1 text-xs text-review">{error}</p>}
      </div>
      <button
        type="button"
        onClick={() => void onRemove()}
        disabled={removing}
        aria-label={`Remove ${friend.displayName ?? "friend"}`}
        className={clsx(
          "shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted transition-all",
          "hover:bg-review/10 hover:text-review",
          "focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-review/30",
          "disabled:cursor-not-allowed disabled:opacity-50",
          // Quiet by default; reveal on row hover (still keyboard-reachable).
          "opacity-0 group-hover:opacity-100",
        )}
      >
        {removing ? "Removing…" : "Remove"}
      </button>
    </div>
  );
}

/** The live status line: "online", "studying X", or "offline". */
function statusLabel(online: boolean, presence: LivePresence | undefined): string {
  if (!online) return "offline";
  const status = presence?.status ?? "online";
  const activity = presence?.activity;
  if (status === "studying") return activity ? `studying ${activity}` : "studying";
  if (status === "focusing") return activity ? `focusing on ${activity}` : "focusing";
  return activity ? `online · ${activity}` : "online";
}

/** A small live dot anchored to the avatar — emerald when online, grey when not. */
function PresenceDot({ online }: { online: boolean }) {
  return (
    <span
      className={clsx(
        "absolute -bottom-0.5 -right-0.5 grid h-3.5 w-3.5 place-items-center rounded-full ring-2 ring-surface",
        online ? "bg-emerald-500" : "bg-ink/25",
      )}
      aria-hidden
    >
      {online && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-200" />
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Shared bits.
// ---------------------------------------------------------------------------

/** A small avatar with a deterministic initials fallback. */
function Avatar({
  name,
  photoURL,
  className,
}: {
  name: string | null;
  photoURL: string | null;
  className?: string;
}) {
  if (photoURL) {
    return (
      <img
        src={photoURL}
        alt={name ?? "Avatar"}
        referrerPolicy="no-referrer"
        className={clsx("shrink-0 rounded-full object-cover", className)}
      />
    );
  }
  return (
    <span
      className={clsx(
        "grid shrink-0 place-items-center rounded-full bg-accent/10 font-serif font-medium text-accent",
        className,
      )}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

/** Up to two initials from a display name; falls back to a person glyph. */
function initials(name: string | null): React.ReactNode {
  if (!name) return <Circle size={14} className="opacity-50" />;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return <Circle size={14} className="opacity-50" />;
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** Section header: eyebrow with a leading icon, matching the editorial motif. */
function SectionLabel({
  icon: Icon,
  tone = "neutral",
  children,
}: {
  icon: typeof Users;
  tone?: "accent" | "neutral";
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon size={15} className={tone === "accent" ? "text-accent" : "text-muted"} />
      <Eyebrow tone={tone}>{children}</Eyebrow>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A tiny copy-to-clipboard helper with a 2s "copied" flash.
// ---------------------------------------------------------------------------

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (insecure context / denied permission); the
      // value stays visible and selectable so it can be copied by hand.
      setCopied(false);
    }
  };
  return { copied, copy };
}

// ---------------------------------------------------------------------------
// Map raw callable errors to calm, learner-facing copy.
// ---------------------------------------------------------------------------

function friendlyError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("unauthenticated"))
    return "Your session expired. Sign in again and retry.";
  if (m.includes("own") || m.includes("yourself") || m.includes("self"))
    return "That's your own code — share it with a friend instead.";
  if (m.includes("already") && m.includes("friend")) return "You're already friends.";
  if (m.includes("already") || m.includes("duplicate") || m.includes("pending"))
    return "A request is already pending with them.";
  if (m.includes("not-found") || m.includes("no ") || m.includes("invalid"))
    return "No one has that friend code. Double-check and try again.";
  if (m.includes("permission") || m.includes("denied"))
    return "That action was refused. Try signing out and back in.";
  return message;
}
