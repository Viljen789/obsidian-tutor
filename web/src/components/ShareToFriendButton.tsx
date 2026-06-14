/**
 * ShareToFriendButton({ subject }) — share a subject straight to a friend.
 *
 * Mounted on the dashboard's subject cards next to the public-link ShareButton.
 * Quiet by default (a ghost button); one click opens a small inline friend
 * picker (the caller's friends, via the useFriends hook from lib/social).
 * Choosing a friend calls useShareSubject with { subject, toUid } — the backend
 * snapshots the subject and drops it in that friend's inbox — and we confirm in
 * place with "Shared with {name}".
 *
 * Loading (friends still loading), empty (no friends yet → a gentle nudge to the
 * Friends page), and error states are all handled inline; the card never blanks.
 * Speaks the reading-room vocabulary from components/ui.
 */
import { useState } from "react";
import { Check, Share2, Users } from "lucide-react";
import type { Friend } from "@tutor/shared";
import { useFriends } from "../lib/social";
import { useShareSubject } from "../lib/sharing";
import { Button, Card, Spinner } from "./ui";

export function ShareToFriendButton({ subject }: { subject: string }) {
  const [open, setOpen] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const friends = useFriends();
  const share = useShareSubject();

  const onPick = (friend: Friend) => {
    setSentTo(friend.displayName ?? "your friend");
    share.mutate(
      { subject, toUid: friend.uid },
      {
        onSuccess: () => setOpen(false),
        // Keep the picker open on failure so they can retry another friend.
        onError: () => setSentTo(null),
      },
    );
  };

  // Confirmation — replaces the button in place after a successful share.
  if (share.isSuccess && sentTo) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-accent">
        <Check size={14} />
        Shared with {sentTo}
      </span>
    );
  }

  // Picker open — a quiet inline popover of friends to choose from.
  if (open) {
    return (
      <Card className="w-64 bg-surface p-2 shadow-sm">
        <FriendPicker
          friends={friends}
          pending={share.isPending}
          error={share.isError}
          onPick={onPick}
          onClose={() => setOpen(false)}
        />
      </Card>
    );
  }

  // Default — a quiet ghost trigger that doesn't compete with the row's actions.
  return (
    <Button
      variant="ghost"
      tone="accent"
      size="sm"
      icon={Share2}
      onClick={() => {
        setSentTo(null);
        share.reset();
        setOpen(true);
      }}
    >
      Share with a friend
    </Button>
  );
}

function FriendPicker({
  friends,
  pending,
  error,
  onPick,
  onClose,
}: {
  friends: ReturnType<typeof useFriends>;
  pending: boolean;
  error: boolean;
  onPick: (friend: Friend) => void;
  onClose: () => void;
}) {
  const header = (
    <div className="flex items-center justify-between px-2 pb-1.5 pt-1">
      <span className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-muted">
        Share with
      </span>
      <button
        type="button"
        onClick={onClose}
        className="rounded-md px-1.5 py-0.5 text-xs text-muted transition-colors hover:bg-ink/[0.05] hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
      >
        Cancel
      </button>
    </div>
  );

  if (friends.isLoading) {
    return (
      <>
        {header}
        <div className="px-2 py-2">
          <Spinner label="Loading friends…" />
        </div>
      </>
    );
  }

  const list = friends.data ?? [];

  if (friends.isError) {
    return (
      <>
        {header}
        <p className="px-2 py-2 text-sm text-review">
          Couldn't load your friends. Try again in a moment.
        </p>
      </>
    );
  }

  if (list.length === 0) {
    return (
      <>
        {header}
        <div className="flex flex-col items-center gap-1 px-2 py-3 text-center">
          <Users size={18} className="text-muted" />
          <p className="text-sm text-ink">No friends yet</p>
          <p className="text-xs text-muted">
            Add a friend on the Friends page, then share with them here.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      {error && (
        <p className="px-2 pb-1 text-xs text-review">
          Couldn't share just now. Pick a friend to try again.
        </p>
      )}
      <ul className="max-h-60 overflow-y-auto">
        {list.map((friend) => (
          <li key={friend.uid}>
            <button
              type="button"
              disabled={pending}
              onClick={() => onPick(friend)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-ink/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Avatar name={friend.displayName} photoURL={friend.photoURL} />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">
                {friend.displayName ?? "Friend"}
              </span>
              <Share2 size={14} className="shrink-0 text-muted" />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** A small avatar with a deterministic initials fallback. */
function Avatar({
  name,
  photoURL,
}: {
  name: string | null;
  photoURL: string | null;
}) {
  if (photoURL) {
    return (
      <img
        src={photoURL}
        alt={name ?? "Avatar"}
        referrerPolicy="no-referrer"
        className="h-7 w-7 shrink-0 rounded-full object-cover"
      />
    );
  }
  const text = initials(name);
  return (
    <span
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/10 text-xs font-medium text-accent"
      aria-hidden
    >
      {text}
    </span>
  );
}

/** Up to two initials from a display name; falls back to a dot. */
function initials(name: string | null): string {
  if (!name) return "·";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "·";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}
