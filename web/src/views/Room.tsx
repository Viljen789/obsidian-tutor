/**
 * Room (/rooms/:roomId) — a single group study room: a SYNCED pomodoro, a live
 * members panel, and live chat.
 *
 * How the pomodoro stays in sync (the important part):
 *   The room doc holds the pomodoro state, but the COUNTDOWN is never written
 *   per-second. A writer stamps `startedAt` (ISO) + `durationSec` once; every
 *   client reads that live (useRoom) and renders the remaining time from a local
 *   1s tick: `remaining = durationSec - (now - startedAt)`. So the number is
 *   identical on every screen with zero per-second traffic.
 *
 *   When a phase elapses (remaining hits 0), exactly ONE client writes the
 *   transition to the next phase — the `runningBy` client, or the owner as a
 *   fallback if `runningBy` is absent/offline. Everyone else just watches the
 *   live doc flip. A short "Break! / Focus!" flash marks the handover. A ref
 *   latch keeps the responsible client from writing the same transition twice.
 *
 * Presence + chat go live via Firestore subscriptions (useRoomPresence /
 * useRoomMessages); this member's own heartbeat (useRoomPresenceHeartbeat)
 * reports "focusing" during a focus block so others see who's heads-down.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { clsx } from "clsx";
import {
  ArrowLeft,
  Check,
  Circle,
  Copy,
  LogOut,
  Pause,
  Play,
  Send,
  SkipForward,
  Users,
} from "lucide-react";
import type { PomodoroState, Room as RoomT } from "@tutor/shared";
import { useAuth } from "../lib/auth";
import {
  leaveRoom,
  nextPhase,
  pomodoroRemaining,
  sendMessage,
  setPomodoro,
  useMemberProfiles,
  useRoom,
  useRoomMessages,
  useRoomPresence,
  useRoomPresenceHeartbeat,
  type LiveRoomPresence,
} from "../lib/rooms";
import {
  Button,
  Card,
  EmptyState,
  Eyebrow,
  Pill,
  Spinner,
} from "../components/ui";

// Preset focus/break lengths (minutes) offered when the timer is idle.
const PRESETS: { label: string; focus: number; break: number }[] = [
  { label: "25 / 5", focus: 25, break: 5 },
  { label: "50 / 10", focus: 50, break: 10 },
  { label: "15 / 3", focus: 15, break: 3 },
];

export function Room() {
  const { roomId } = useParams<{ roomId: string }>();
  const { room, loading, missing } = useRoom(roomId);

  if (loading) {
    return (
      <div className="animate-fade grid place-items-center py-24">
        <Spinner label="Opening the room…" />
      </div>
    );
  }

  if (missing || !room || !roomId) {
    return (
      <div className="animate-fade">
        <BackLink />
        <Card className="mt-4">
          <EmptyState
            icon={Users}
            title="You're not in this room"
            description="This room doesn't exist, or you've left it. Head back and join with a code."
            action={
              <Link to="/rooms">
                <Button variant="secondary" tone="neutral" icon={ArrowLeft}>
                  Back to rooms
                </Button>
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  return <RoomInner roomId={roomId} room={room} />;
}

// ---------------------------------------------------------------------------
// The live room, once we know it exists and we're a member.
// ---------------------------------------------------------------------------

function RoomInner({ roomId, room }: { roomId: string; room: RoomT }) {
  const { user } = useAuth();
  const uid = user?.uid ?? "";

  const pomo = room.pomodoro;
  const now = useNow(); // 1s tick driving the countdown.
  const remaining = pomodoroRemaining(pomo, now);
  const inFocus = pomo.phase === "focus" && remaining > 0;

  // Broadcast my presence into the room; "focusing" during a live focus block.
  useRoomPresenceHeartbeat(roomId, inFocus ? "focusing" : "online");

  // Auto-advance the phase exactly once, by exactly one client (see helper).
  useAutoAdvance(roomId, room, uid, now);

  return (
    <div className="animate-fade space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <BackLink />
          <h1 className="mt-1 truncate font-serif text-[2rem] tracking-tight text-ink">
            {room.name}
          </h1>
        </div>
        <InviteCode code={room.code} />
      </header>

      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <PomodoroPanel room={room} uid={uid} remaining={remaining} now={now} />
        <MembersPanel roomId={roomId} room={room} uid={uid} />
      </div>

      <ChatPanel roomId={roomId} uid={uid} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The synced pomodoro panel.
// ---------------------------------------------------------------------------

function PomodoroPanel({
  room,
  uid,
  remaining,
  now,
}: {
  room: RoomT;
  uid: string;
  remaining: number;
  now: number;
}) {
  const pomo = room.pomodoro;
  const idle = pomo.phase === "idle";
  const inFocus = pomo.phase === "focus";
  const tone = inFocus ? "accent" : idle ? "neutral" : "review";

  // Fraction elapsed of the current phase (0..1), for the progress ring.
  const elapsedFrac = useMemo(() => {
    if (idle || pomo.durationSec <= 0) return 0;
    const done = (pomo.durationSec - remaining) / pomo.durationSec;
    return Math.max(0, Math.min(1, done));
  }, [idle, pomo.durationSec, remaining]);

  // Local config while idle (focus/break minutes) — only written on Start.
  const [focusMin, setFocusMin] = useState(() => Math.round(pomo.focusSec / 60));
  const [breakMin, setBreakMin] = useState(() => Math.round(pomo.breakSec / 60));

  // Keep local config in step with the live doc whenever it changes (e.g. a
  // teammate started a 50/10 block) — but only while idle, so editing isn't
  // yanked out from under the user mid-type.
  useEffect(() => {
    if (idle) {
      setFocusMin(Math.round(pomo.focusSec / 60));
      setBreakMin(Math.round(pomo.breakSec / 60));
    }
  }, [idle, pomo.focusSec, pomo.breakSec]);

  const [busy, setBusy] = useState(false);

  const write = async (next: PomodoroState) => {
    setBusy(true);
    try {
      await setPomodoro(room.id, next);
    } catch {
      // A transient write failure self-corrects on the next control press;
      // the live doc remains the source of truth.
    } finally {
      setBusy(false);
    }
  };

  const startFocus = () => {
    const focusSec = clampMinutes(focusMin) * 60;
    const breakSec = clampMinutes(breakMin) * 60;
    void write({
      ...pomo,
      phase: "focus",
      startedAt: new Date().toISOString(),
      durationSec: focusSec,
      focusSec,
      breakSec,
      runningBy: uid,
    });
  };

  const stop = () => {
    void write({
      ...pomo,
      phase: "idle",
      startedAt: null,
      runningBy: null,
    });
  };

  const skip = () => {
    void write({ ...nextPhase(pomo), runningBy: uid });
  };

  const phaseLabel = idle ? "Ready" : inFocus ? "Focus" : "Break";

  return (
    <Card className="flex flex-col items-center p-7">
      <div className="flex items-center gap-2">
        <Eyebrow tone={tone}>{phaseLabel}</Eyebrow>
        <Pill tone="neutral">Cycle {pomo.cycle}</Pill>
      </div>

      {/* Transition flash + countdown ring. */}
      <TransitionFlash phase={pomo.phase} startedAt={pomo.startedAt} now={now} />

      <CountdownRing
        seconds={Math.round(remaining)}
        fraction={elapsedFrac}
        idle={idle}
        tone={tone}
        idleSeconds={clampMinutes(focusMin) * 60}
      />

      {/* Controls. */}
      <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
        {idle ? (
          <Button icon={Play} onClick={startFocus} loading={busy} tone="accent">
            Start focus
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              tone="neutral"
              icon={Pause}
              onClick={stop}
              loading={busy}
            >
              Stop
            </Button>
            <Button
              variant="secondary"
              tone="neutral"
              icon={SkipForward}
              onClick={skip}
              loading={busy}
            >
              {inFocus ? "Skip to break" : "Skip to focus"}
            </Button>
          </>
        )}
      </div>

      {/* Length presets / editing — only while idle. */}
      {idle && (
        <LengthEditor
          focusMin={focusMin}
          breakMin={breakMin}
          onFocus={setFocusMin}
          onBreak={setBreakMin}
        />
      )}

      {!idle && pomo.runningBy && (
        <p className="mt-5 text-xs text-muted">
          Timer running — everyone here is on the same clock.
        </p>
      )}
    </Card>
  );
}

/** A circular countdown: a progress ring around a big mm:ss readout. */
function CountdownRing({
  seconds,
  fraction,
  idle,
  tone,
  idleSeconds,
}: {
  seconds: number;
  fraction: number;
  idle: boolean;
  tone: "accent" | "review" | "neutral";
  idleSeconds: number;
}) {
  const size = 220;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  // Ring depletes as the phase elapses (idle shows a full, quiet ring).
  const offset = idle ? 0 : circ * Math.max(0, Math.min(1, fraction));
  // Theme tokens are space-separated RGB triples (`--accent: 79 70 229`) used as
  // `rgb(var(--accent))`; they flip for dark mode, so the ring stays on-theme.
  const strokeColor =
    tone === "accent"
      ? "rgb(var(--accent))"
      : tone === "review"
        ? "rgb(var(--review))"
        : "rgb(var(--muted))";

  const shown = idle ? idleSeconds : seconds;

  return (
    <div
      className="relative mt-6 grid place-items-center"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className={clsx(
          "-rotate-90",
          tone === "neutral" && "text-ink/15",
        )}
      >
        {/* Track. */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          className="text-ink/[0.08]"
        />
        {/* Progress. */}
        {!idle && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={strokeColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 1s linear" }}
          />
        )}
      </svg>
      <div className="absolute inset-0 grid place-content-center text-center">
        <span
          className={clsx(
            "font-serif text-5xl tabular-nums tracking-tight",
            tone === "accent"
              ? "text-accent"
              : tone === "review"
                ? "text-review"
                : "text-ink",
          )}
        >
          {fmtClock(shown)}
        </span>
        <span className="mt-1 text-xs uppercase tracking-[0.18em] text-muted">
          {idle ? "press start" : tone === "accent" ? "stay focused" : "take a breath"}
        </span>
      </div>
    </div>
  );
}

/** Brief "Focus! / Break!" flash shown right after a phase begins. */
function TransitionFlash({
  phase,
  startedAt,
  now,
}: {
  phase: PomodoroState["phase"];
  startedAt: string | null;
  now: number;
}) {
  if (phase === "idle" || !startedAt) return null;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  // Only within the first ~3s of a phase.
  const age = (now - started) / 1000;
  if (age < 0 || age > 3) return null;

  const isFocus = phase === "focus";
  return (
    <p
      className={clsx(
        "animate-rise -mb-2 mt-3 text-sm font-medium",
        isFocus ? "text-accent" : "text-review",
      )}
    >
      {isFocus ? "Focus! Heads down." : "Break! Stretch a little."}
    </p>
  );
}

/** Focus/break length editing with quick presets, shown only when idle. */
function LengthEditor({
  focusMin,
  breakMin,
  onFocus,
  onBreak,
}: {
  focusMin: number;
  breakMin: number;
  onFocus: (n: number) => void;
  onBreak: (n: number) => void;
}) {
  return (
    <div className="mt-7 w-full border-t border-border pt-5">
      <div className="flex flex-wrap items-center justify-center gap-2">
        {PRESETS.map((p) => {
          const active = p.focus === focusMin && p.break === breakMin;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                onFocus(p.focus);
                onBreak(p.break);
              }}
              className={clsx(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                active
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-border text-muted hover:bg-ink/[0.03]",
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex items-center justify-center gap-6 text-sm">
        <MinuteField label="Focus" value={focusMin} onChange={onFocus} />
        <MinuteField label="Break" value={breakMin} onChange={onBreak} />
      </div>
    </div>
  );
}

function MinuteField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-muted">
      <span className="text-xs uppercase tracking-wide">{label}</span>
      <input
        type="number"
        min={1}
        max={180}
        value={value}
        onChange={(e) => onChange(clampMinutes(Number(e.target.value)))}
        className="w-16 rounded-lg border border-border bg-bg/50 px-2 py-1 text-center text-sm tabular-nums text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        aria-label={`${label} minutes`}
      />
      <span className="text-xs">min</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Members panel — live presence + leave.
// ---------------------------------------------------------------------------

function MembersPanel({
  roomId,
  room,
  uid,
}: {
  roomId: string;
  room: RoomT;
  uid: string;
}) {
  const navigate = useNavigate();
  const presence = useRoomPresence(roomId);
  const profiles = useMemberProfiles(room.members);

  // Online members first, then by name.
  const ordered = useMemo(() => {
    const names = (id: string) => profiles[id]?.displayName ?? "";
    return [...room.members].sort((a, b) => {
      const ao = presence[a]?.online ? 1 : 0;
      const bo = presence[b]?.online ? 1 : 0;
      if (ao !== bo) return bo - ao;
      return names(a).localeCompare(names(b));
    });
  }, [room.members, presence, profiles]);

  const onlineCount = useMemo(
    () => room.members.reduce((n, id) => n + (presence[id]?.online ? 1 : 0), 0),
    [room.members, presence],
  );

  const [leaving, setLeaving] = useState(false);
  const onLeave = async () => {
    if (!uid) return;
    setLeaving(true);
    try {
      await leaveRoom(roomId, uid);
      navigate("/rooms");
    } catch {
      setLeaving(false);
    }
  };

  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Users size={15} className="text-muted" />
          <Eyebrow>Members</Eyebrow>
        </div>
        <span className="text-xs text-muted">
          {onlineCount > 0 ? `${onlineCount} online` : "none online"}
        </span>
      </div>

      <ul className="mt-3 flex-1 space-y-1">
        {ordered.map((memberUid) => (
          <MemberRow
            key={memberUid}
            uid={memberUid}
            isMe={memberUid === uid}
            isOwner={memberUid === room.ownerId}
            profile={profiles[memberUid]}
            presence={presence[memberUid]}
          />
        ))}
      </ul>

      <div className="mt-4 border-t border-border pt-4">
        <Button
          variant="ghost"
          tone="neutral"
          size="sm"
          icon={LogOut}
          onClick={() => void onLeave()}
          loading={leaving}
          className="w-full justify-center text-muted hover:text-review"
        >
          {leaving ? "Leaving…" : "Leave room"}
        </Button>
      </div>
    </Card>
  );
}

function MemberRow({
  uid,
  isMe,
  isOwner,
  profile,
  presence,
}: {
  uid: string;
  isMe: boolean;
  isOwner: boolean;
  profile: { displayName: string | null; photoURL: string | null } | undefined;
  presence: LiveRoomPresence | undefined;
}) {
  const online = presence?.online ?? false;
  const focusing = online && presence?.status === "focusing";
  const name = profile?.displayName ?? (isMe ? "You" : "Member");

  return (
    <li className="flex items-center gap-3 rounded-lg px-2 py-2">
      <div className="relative shrink-0">
        <Avatar
          name={profile?.displayName ?? null}
          photoURL={profile?.photoURL ?? null}
          fallbackKey={uid}
          className="h-9 w-9"
        />
        <PresenceDot online={online} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm font-medium text-ink">
          <span className="truncate">
            {name}
            {isMe && !profile?.displayName ? "" : isMe ? " (you)" : ""}
          </span>
          {isOwner && (
            <span className="shrink-0 text-[0.65rem] uppercase tracking-wide text-muted">
              host
            </span>
          )}
        </p>
        <p className="truncate text-xs text-muted">
          {focusing ? (
            <span className="text-accent">focusing</span>
          ) : online ? (
            "online"
          ) : (
            "away"
          )}
        </p>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Chat panel — live feed + composer.
// ---------------------------------------------------------------------------

function ChatPanel({ roomId, uid }: { roomId: string; uid: string }) {
  const { user } = useAuth();
  const { messages, loading } = useRoomMessages(roomId);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to newest whenever the feed grows (or on first load).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || !uid) return;
    setSending(true);
    setDraft("");
    try {
      await sendMessage(roomId, uid, user?.displayName ?? null, text);
    } catch {
      // On failure, restore the draft so the learner can retry.
      setDraft(text);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-center gap-2">
        <Send size={15} className="text-muted" />
        <Eyebrow>Chat</Eyebrow>
      </div>

      <div
        ref={scrollRef}
        className="mt-3 h-64 space-y-2 overflow-y-auto rounded-xl border border-border bg-bg/30 p-3"
      >
        {loading ? (
          <div className="grid h-full place-items-center">
            <Spinner label="Loading chat…" />
          </div>
        ) : messages.length === 0 ? (
          <div className="grid h-full place-items-center text-center">
            <p className="max-w-xs text-sm text-muted">
              No messages yet. Say hi and keep each other accountable.
            </p>
          </div>
        ) : (
          messages.map((m) => (
            <MessageBubble key={m.id} message={m} mine={m.uid === uid} />
          ))
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message the room…"
          aria-label="Message the room"
          maxLength={500}
          className="min-w-0 flex-1 rounded-xl border border-border bg-bg/50 px-3.5 py-2.5 text-sm text-ink placeholder:text-muted/70 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        <Button
          icon={Send}
          onClick={() => void send()}
          loading={sending}
          disabled={draft.trim().length === 0}
          className="shrink-0"
          aria-label="Send message"
        >
          Send
        </Button>
      </div>
    </Card>
  );
}

function MessageBubble({
  message,
  mine,
}: {
  message: { name: string | null; text: string; createdAt: string };
  mine: boolean;
}) {
  return (
    <div className={clsx("flex flex-col", mine ? "items-end" : "items-start")}>
      <div
        className={clsx(
          "max-w-[80%] rounded-2xl px-3.5 py-2",
          mine
            ? "rounded-br-md bg-accent/10 text-ink"
            : "rounded-bl-md border border-border bg-surface text-ink",
        )}
      >
        {!mine && (
          <p className="mb-0.5 text-xs font-medium text-accent">
            {message.name ?? "Member"}
          </p>
        )}
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {message.text}
        </p>
      </div>
      <span className="mt-0.5 px-1 text-[0.65rem] text-muted">
        {fmtTime(message.createdAt)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auto-advance — exactly one client writes the phase transition.
// ---------------------------------------------------------------------------

/**
 * When the running phase elapses, write the transition to the next phase — but
 * only from ONE client, to avoid every member racing to write. The responsible
 * writer is `pomodoro.runningBy`; if that uid isn't the current member we fall
 * back to the OWNER writing (covers a runningBy who went offline). A ref latch,
 * keyed by `phase|startedAt`, guarantees the responsible client fires the write
 * at most once per phase even across the per-second re-renders.
 */
function useAutoAdvance(
  roomId: string,
  room: RoomT,
  uid: string,
  now: number,
): void {
  const firedFor = useRef<string | null>(null);
  const pomo = room.pomodoro;

  useEffect(() => {
    if (pomo.phase === "idle" || !pomo.startedAt) return;
    const remaining = pomodoroRemaining(pomo, now);
    if (remaining > 0) return;

    // Am I the one responsible for writing this transition?
    const iAmRunner = pomo.runningBy === uid;
    const iAmOwnerFallback = pomo.runningBy == null && room.ownerId === uid;
    if (!iAmRunner && !iAmOwnerFallback) return;

    // One write per phase instance (phase + startedAt uniquely identify it).
    const key = `${pomo.phase}|${pomo.startedAt}`;
    if (firedFor.current === key) return;
    firedFor.current = key;

    void setPomodoro(roomId, nextPhase(pomo)).catch(() => {
      // Let a later tick retry if the write failed.
      firedFor.current = null;
    });
  }, [roomId, room.ownerId, uid, pomo, now]);
}

// ---------------------------------------------------------------------------
// Invite code — copyable, the "share invite" affordance.
// ---------------------------------------------------------------------------

function InviteCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-2.5">
      <Eyebrow>Invite code</Eyebrow>
      <div className="mt-1 flex items-center gap-2">
        <span className="select-all font-mono text-lg tracking-[0.2em] text-accent">
          {code}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label="Copy invite code"
          className="rounded-lg p-1.5 text-muted transition-colors hover:bg-ink/[0.04] hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
        >
          {copied ? <Check size={15} className="text-accent" /> : <Copy size={15} />}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits.
// ---------------------------------------------------------------------------

function BackLink() {
  return (
    <Link
      to="/rooms"
      className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink"
    >
      <ArrowLeft size={15} />
      Rooms
    </Link>
  );
}

/** A small live dot anchored to an avatar — emerald online, grey away. */
function PresenceDot({ online }: { online: boolean }) {
  return (
    <span
      className={clsx(
        "absolute -bottom-0.5 -right-0.5 grid h-3 w-3 place-items-center rounded-full ring-2 ring-surface",
        online ? "bg-emerald-500" : "bg-ink/25",
      )}
      aria-hidden
    >
      {online && (
        <span className="h-1 w-1 animate-pulse rounded-full bg-emerald-200" />
      )}
    </span>
  );
}

/** Avatar with a deterministic initials fallback (keyed by uid when nameless). */
function Avatar({
  name,
  photoURL,
  fallbackKey,
  className,
}: {
  name: string | null;
  photoURL: string | null;
  fallbackKey: string;
  className?: string;
}) {
  if (photoURL) {
    return (
      <img
        src={photoURL}
        alt={name ?? "Member"}
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
      {initials(name, fallbackKey)}
    </span>
  );
}

/** Up to two initials from a display name; a stable letter from uid otherwise. */
function initials(name: string | null, fallbackKey: string): React.ReactNode {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    const ch = fallbackKey.trim()[0];
    return ch ? ch.toUpperCase() : <Circle size={13} className="opacity-50" />;
  }
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

// ---------------------------------------------------------------------------
// Time / clock formatting.
// ---------------------------------------------------------------------------

/** A 1-second ticking clock (epoch ms). Cleaned up on unmount. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** Seconds → "mm:ss" (rounded, never negative). */
function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** ISO timestamp → short local time "3:04 PM" (empty when unparseable). */
function fmtTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Clamp a minutes input to a sane 1..180 integer. */
function clampMinutes(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(180, Math.round(n)));
}
