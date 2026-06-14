/**
 * "Ask a follow-up" — a quiet, collapsible chat panel that sits beneath a
 * lesson. Collapsed by default to a single unobtrusive button; expanding reveals
 * a session-local thread you can converse in.
 *
 * The transcript is deliberately ephemeral: it lives in component state and is
 * NOT persisted, so a follow-up question is a low-stakes aside that vanishes
 * when you move on. Each turn re-sends the running transcript to
 * `api.tutorChat`, which grounds the reply in the concept's notes and appends
 * the tutor's answer. Learner turns are tinted and aligned to the right; the
 * tutor's turns render as markdown in the reading column's voice.
 *
 * Every network step degrades gently: a typing indicator while awaiting a
 * reply, and an inline error with a retry that never loses what you typed.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { MessageCircle, Send, X } from "lucide-react";
import type { ChatMessage } from "@tutor/shared";
import { api } from "../lib/api";
import { Button, Card, Eyebrow, type Tone } from "./ui";
import { Markdown } from "./Markdown";

export function TutorChat({
  conceptId,
  tone,
}: {
  conceptId: string;
  tone: Tone;
}) {
  const [open, setOpen] = useState(false);

  // Collapsed: a single quiet invitation. Expanding is the only state change
  // here — the thread itself (below) owns the conversation.
  if (!open) {
    return (
      <div className="animate-fade flex justify-center">
        <Button
          variant="secondary"
          tone="neutral"
          icon={MessageCircle}
          onClick={() => setOpen(true)}
        >
          Ask a follow-up
        </Button>
      </div>
    );
  }

  return <ChatThread conceptId={conceptId} tone={tone} onClose={() => setOpen(false)} />;
}

// ---------------------------------------------------------------------------
// The expanded thread: session-local transcript + a send box.
// ---------------------------------------------------------------------------

function ChatThread({
  conceptId,
  tone,
  onClose,
}: {
  conceptId: string;
  tone: Tone;
  onClose: () => void;
}) {
  // Session-local, never persisted. Oldest first; the tutor's replies are
  // appended on success.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const send = useMutation({
    mutationFn: (transcript: ChatMessage[]) =>
      api.tutorChat({ conceptId, messages: transcript }),
    onSuccess: (res) => {
      setMessages((prev) => [...prev, { role: "tutor", content: res.reply }]);
    },
  });

  // Keep the latest turn in view as the conversation grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, send.isPending]);

  function submit() {
    const content = draft.trim();
    if (!content || send.isPending) return;
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setDraft("");
    send.mutate(next);
  }

  // Retry resends the current transcript unchanged — the last turn is already
  // the learner's unanswered question, so nothing typed is lost.
  function retry() {
    if (messages.length === 0 || send.isPending) return;
    send.mutate(messages);
  }

  const accentText = tone === "review" ? "text-review" : "text-accent";
  const learnerBubble =
    tone === "review"
      ? "bg-review/10 text-ink"
      : "bg-accent/10 text-ink";

  return (
    <Card className="animate-rise overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <span className="inline-flex items-center gap-2">
          <MessageCircle size={15} className={accentText} />
          <Eyebrow tone={tone}>Ask a follow-up</Eyebrow>
        </span>
        <button
          onClick={onClose}
          aria-label="Close follow-up"
          className="rounded-lg p-1 text-muted transition-colors hover:bg-ink/[0.04] hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      {/* Transcript */}
      <div
        ref={scrollRef}
        className="max-h-[26rem] space-y-3 overflow-y-auto px-5 py-4"
      >
        {messages.length === 0 ? (
          <p className="py-6 text-center text-sm leading-relaxed text-muted">
            Stuck on a detail, or curious where this leads? Ask anything about
            this concept — the tutor has your notes in view.
          </p>
        ) : (
          messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div
                  className={
                    "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md px-3.5 py-2 text-[0.9rem] leading-relaxed " +
                    learnerBubble
                  }
                >
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-border bg-bg/50 px-3.5 py-2.5 text-[0.9rem]">
                  <Markdown>{m.content}</Markdown>
                </div>
              </div>
            ),
          )
        )}

        {/* Awaiting a reply — a quiet three-dot pulse in the tutor's lane. */}
        {send.isPending && (
          <div className="flex justify-start">
            <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-border bg-bg/50 px-4 py-3">
              <Dot delay="0ms" />
              <Dot delay="150ms" />
              <Dot delay="300ms" />
            </div>
          </div>
        )}

        {/* Error — retry resends without touching the draft. */}
        {send.isError && (
          <div className="flex justify-start">
            <div className="max-w-[92%] rounded-xl border border-border bg-bg/50 px-3.5 py-2.5 text-sm text-muted">
              That didn't go through.{" "}
              <button
                onClick={retry}
                className={"font-medium underline-offset-2 hover:underline " + accentText}
              >
                Try again
              </button>
              .
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter inserts a newline for longer questions.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Ask a follow-up…"
            className={
              "max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-xl border border-border bg-bg/50 px-3.5 py-2.5 text-[0.9rem] leading-relaxed text-ink placeholder:text-muted/70 " +
              "transition focus:outline-none focus:ring-2 focus:ring-offset-0 " +
              (tone === "review" ? "focus:ring-review/30" : "focus:ring-accent/30")
            }
          />
          <Button
            tone={tone}
            icon={Send}
            onClick={submit}
            loading={send.isPending}
            disabled={draft.trim().length === 0}
            aria-label="Send"
          >
            <span className="sr-only sm:not-sr-only">Send</span>
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** A single pulsing dot for the tutor's "typing" indicator. */
function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted"
      style={{ animationDelay: delay }}
    />
  );
}
