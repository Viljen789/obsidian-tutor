/**
 * Rooms (/rooms) — the home for group study rooms. Two ways in, one list out:
 *
 *   1. Create a room (name → api.createRoom) → drop straight into it.
 *   2. Join by code (code → api.joinRoom) → drop straight into it.
 *   3. Your rooms — a live list (useMyRooms) of every room you're a member of,
 *      each showing member count and, when a focus block is running, a live
 *      "N focusing" pulse. Click a card to enter.
 *
 * Creating/joining are server callables (they mint/verify the code; a
 * non-member can't read a room to find it). The list is a live Firestore
 * subscription, so a room you create or join shows up at once. The reading-room
 * vocabulary from components/ui keeps it of a piece with the rest of Tutor.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DoorOpen, Plus, Timer, Users } from "lucide-react";
import type { Room } from "@tutor/shared";
import { api } from "../lib/api";
import { pomodoroRemaining, useMyRooms } from "../lib/rooms";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Eyebrow,
  Pill,
  Skeleton,
} from "../components/ui";

export function Rooms() {
  const { rooms, loading, error } = useMyRooms();

  return (
    <div className="animate-fade space-y-7">
      <header>
        <Eyebrow tone="accent">Study rooms</Eyebrow>
        <h1 className="mt-1.5 font-serif text-[2rem] tracking-tight text-ink">
          Focus together
        </h1>
        <p className="mt-1 max-w-lg text-[0.95rem] leading-relaxed text-muted">
          Start a room and share its code, or join a friend's. A shared pomodoro
          keeps everyone on the same clock — the hard hours go faster in company.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <CreateRoom />
        <JoinRoom />
      </div>

      <MyRoomsSection rooms={rooms} loading={loading} error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create a room.
// ---------------------------------------------------------------------------

type CreateState =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "error"; message: string };

function CreateRoom() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [state, setState] = useState<CreateState>({ kind: "idle" });

  const trimmed = name.trim();
  const canCreate = trimmed.length > 0 && state.kind !== "creating";

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    setState({ kind: "creating" });
    try {
      const { roomId } = await api.createRoom({ name: trimmed });
      navigate(`/rooms/${roomId}`);
    } catch (err) {
      setState({ kind: "error", message: friendlyError(err) });
    }
  };

  return (
    <Card className="flex flex-col p-6">
      <div className="flex items-center gap-2">
        <Plus size={15} className="text-accent" />
        <Eyebrow tone="accent">New room</Eyebrow>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Name a room and you'll get a code to share with friends.
      </p>

      <form
        onSubmit={(e) => void onSubmit(e)}
        className="mt-4 flex flex-col gap-2"
      >
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (state.kind === "error") setState({ kind: "idle" });
          }}
          placeholder="e.g. Finals grind"
          aria-label="Room name"
          maxLength={60}
          className="w-full rounded-xl border border-border bg-bg/50 px-3.5 py-2.5 text-sm text-ink placeholder:text-muted/70 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        <Button
          type="submit"
          icon={Plus}
          loading={state.kind === "creating"}
          disabled={!canCreate}
        >
          {state.kind === "creating" ? "Creating…" : "Create room"}
        </Button>
      </form>

      {state.kind === "error" && (
        <p className="mt-3 text-sm text-review">{state.message}</p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Join by code.
// ---------------------------------------------------------------------------

type JoinState =
  | { kind: "idle" }
  | { kind: "joining" }
  | { kind: "error"; message: string };

function JoinRoom() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [state, setState] = useState<JoinState>({ kind: "idle" });

  const trimmed = code.trim();
  const canJoin = trimmed.length > 0 && state.kind !== "joining";

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canJoin) return;
    setState({ kind: "joining" });
    try {
      const { roomId } = await api.joinRoom({ code: trimmed });
      navigate(`/rooms/${roomId}`);
    } catch (err) {
      setState({ kind: "error", message: friendlyError(err) });
    }
  };

  return (
    <Card className="flex flex-col p-6">
      <div className="flex items-center gap-2">
        <DoorOpen size={15} className="text-accent" />
        <Eyebrow tone="accent">Join a room</Eyebrow>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Got a code from a friend? Enter it to join their room.
      </p>

      <form
        onSubmit={(e) => void onSubmit(e)}
        className="mt-4 flex flex-col gap-2"
      >
        <input
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase());
            if (state.kind === "error") setState({ kind: "idle" });
          }}
          placeholder="Room code"
          aria-label="Room code"
          autoCapitalize="characters"
          spellCheck={false}
          className="w-full rounded-xl border border-border bg-bg/50 px-3.5 py-2.5 text-sm uppercase tracking-[0.2em] text-ink placeholder:tracking-normal placeholder:text-muted/70 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        <Button
          type="submit"
          variant="secondary"
          tone="neutral"
          icon={DoorOpen}
          loading={state.kind === "joining"}
          disabled={!canJoin}
        >
          {state.kind === "joining" ? "Joining…" : "Join room"}
        </Button>
      </form>

      {state.kind === "error" && (
        <p className="mt-3 text-sm text-review">{state.message}</p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// My rooms — the live list.
// ---------------------------------------------------------------------------

function MyRoomsSection({
  rooms,
  loading,
  error,
}: {
  rooms: Room[];
  loading: boolean;
  error: boolean;
}) {
  return (
    <section>
      <div className="flex items-center gap-2">
        <Users size={15} className="text-muted" />
        <Eyebrow>Your rooms</Eyebrow>
        {rooms.length > 0 && (
          <span className="text-xs text-muted">{rooms.length}</span>
        )}
      </div>

      {loading ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <Card key={i} className="p-5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-3 h-3 w-24" />
            </Card>
          ))}
        </div>
      ) : error ? (
        <Card className="mt-3">
          <ErrorState
            title="Couldn't load your rooms"
            description="Your rooms didn't come through just now. They'll reappear once the connection settles."
          />
        </Card>
      ) : rooms.length === 0 ? (
        <Card className="mt-3">
          <EmptyState
            icon={Timer}
            title="No rooms yet"
            description="Create a room above to get a shareable code, or join a friend's with theirs."
          />
        </Card>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {rooms.map((room) => (
            <RoomCard key={room.id} room={room} />
          ))}
        </div>
      )}
    </section>
  );
}

function RoomCard({ room }: { room: Room }) {
  const navigate = useNavigate();

  // A focus block is "running" when the pomodoro is mid-focus with time left.
  // We can't see live per-member presence from the list, but if a focus block
  // is active we can say the room is focusing — a calm, honest live signal.
  const focusing = useMemo(() => {
    const p = room.pomodoro;
    return p.phase === "focus" && pomodoroRemaining(p) > 0;
  }, [room.pomodoro]);

  const memberCount = room.members.length;

  return (
    <Card
      as="article"
      className="animate-rise group cursor-pointer p-5 transition-colors hover:bg-ink/[0.02]"
    >
      <button
        type="button"
        onClick={() => navigate(`/rooms/${room.id}`)}
        className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded-lg"
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 truncate font-serif text-lg text-ink">
            {room.name}
          </h3>
          {focusing && (
            <Pill tone="accent" className="shrink-0">
              <span className="relative mr-0.5 flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
              </span>
              Focusing
            </Pill>
          )}
        </div>
        <div className="mt-2 flex items-center gap-3 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            <Users size={13} />
            {memberCount} {memberCount === 1 ? "member" : "members"}
          </span>
          <span className="inline-flex items-center gap-1 font-mono tracking-wider">
            <Timer size={13} />
            {room.code}
          </span>
        </div>
      </button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Map raw callable errors to calm, learner-facing copy.
// ---------------------------------------------------------------------------

function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  const m = message.toLowerCase();
  if (m.includes("unauthenticated"))
    return "Your session expired. Sign in again and retry.";
  if (m.includes("full") || m.includes("capacity") || m.includes("limit"))
    return "That room is full right now. Try again later or start your own.";
  if (m.includes("already") && m.includes("member"))
    return "You're already in that room — it's in your list below.";
  if (
    m.includes("not-found") ||
    m.includes("no ") ||
    m.includes("invalid") ||
    m.includes("code")
  )
    return "No room has that code. Double-check it and try again.";
  if (m.includes("permission") || m.includes("denied"))
    return "That action was refused. Try signing out and back in.";
  return message || "Something went sideways. Give it another go.";
}
