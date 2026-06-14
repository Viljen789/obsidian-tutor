/**
 * ShareButton({ subject }) — turns a subject into a public, read-only link.
 *
 * Mounted on the dashboard's subject rows. One click calls api.createShare,
 * which snapshots the subject's concepts (server-side) into an unguessable
 * `shares/{id}` doc and returns its id. We then reveal the share URL with a
 * copy-to-clipboard affordance — the whole exchange happens in place, no modal.
 *
 * It speaks the reading-room vocabulary (ui.tsx Button / Card / Pill) and stays
 * quiet by default (a ghost button) so it never competes with the row's primary
 * actions. Loading + error states are handled inline; the row never blanks.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Share2 } from "lucide-react";
import { api } from "../lib/api";
import { Button, Card, Pill } from "./ui";

export function ShareButton({ subject }: { subject: string }) {
  const [copied, setCopied] = useState(false);

  const share = useMutation({
    mutationFn: () => api.createShare({ subject }),
  });

  // Build the public URL from the returned id. `origin` is correct in every
  // environment (dev emulator, preview, prod) without hard-coding a host.
  const shareUrl = share.data
    ? `${window.location.origin}/share/${share.data.shareId}`
    : null;

  const onCopy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (insecure context / denied permission). Leave
      // the URL visible and selectable so the reader can copy it by hand.
      setCopied(false);
    }
  };

  // Success — reveal the link with a copy control. Replaces the button in place.
  if (share.isSuccess && shareUrl) {
    return (
      <Card className="bg-accent/[0.03]">
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <Pill tone="accent">
              <Share2 size={12} />
              Public link
            </Pill>
            <span className="text-xs text-muted">
              {share.data.conceptCount}{" "}
              {share.data.conceptCount === 1 ? "concept" : "concepts"} · anyone
              with the link can read it
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={shareUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label="Share link"
            />
            <Button
              variant="secondary"
              tone="neutral"
              size="sm"
              icon={copied ? Check : Copy}
              onClick={onCopy}
              className="shrink-0"
            >
              {copied ? "Copied!" : "Copy"}
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  // Default / loading / error — a quiet ghost button that reflects its state.
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        tone="accent"
        size="sm"
        icon={Share2}
        loading={share.isPending}
        onClick={() => share.mutate()}
      >
        {share.isPending ? "Sharing" : share.isError ? "Try again" : "Share subject"}
      </Button>
      {share.isError && (
        <span className="text-xs text-muted">
          Couldn't create the link. Please try again.
        </span>
      )}
    </div>
  );
}
