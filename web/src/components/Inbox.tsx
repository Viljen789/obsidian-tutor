/**
 * Inbox() — incoming shared decks, mounted on the dashboard.
 *
 * Lists the decks friends have shared with the signed-in learner (live, via
 * useInbox). Each row offers two actions:
 *   - Import → useImportDeck: copies the deck into the learner's OWN vault
 *     (fresh concepts, their own mastery), then shows "Imported N concepts" in
 *     place and clears the inbox item.
 *   - Dismiss → useDismissInbox: drops the item without importing.
 *
 * Renders NOTHING when the inbox is empty (and while it's still loading, or on a
 * read error) — it's a quiet, transient surface that should never add an empty
 * header to the dashboard. Speaks the reading-room vocabulary from components/ui.
 */
import { Check, Download, Inbox as InboxIcon, X } from "lucide-react";
import type { InboxItem } from "@tutor/shared";
import { useDismissInbox, useImportDeck, useInbox } from "../lib/sharing";
import { Button, Card, Eyebrow, Pill, SubjectDot } from "./ui";

export function Inbox() {
  const inbox = useInbox();
  const items = inbox.data ?? [];

  // Quiet by design: nothing to show while loading, on error, or when empty —
  // the dashboard shouldn't carry an empty "Shared with you" header.
  if (items.length === 0) return null;

  return (
    <section className="animate-fade">
      <div className="flex items-center gap-2">
        <InboxIcon size={15} className="text-accent" />
        <Eyebrow tone="accent">Shared with you</Eyebrow>
        <Pill tone="accent" className="ml-1">
          {items.length}
        </Pill>
      </div>
      <Card className="mt-3 divide-y divide-border">
        {items.map((item) => (
          <InboxRow key={item.id} item={item} />
        ))}
      </Card>
    </section>
  );
}

function InboxRow({ item }: { item: InboxItem }) {
  const importDeck = useImportDeck();
  const dismiss = useDismissInbox();

  const from = item.fromName ?? "A friend";

  // Once imported, the row stays put showing the outcome (the live subscription
  // also removes the underlying item, but holding the confirmation reads better
  // than a row that simply vanishes mid-click).
  if (importDeck.isSuccess && importDeck.data) {
    const n = importDeck.data.conceptCount;
    return (
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent/10 text-accent">
          <Check size={16} />
        </span>
        <p className="min-w-0 flex-1 text-sm text-ink">
          Imported{" "}
          <span className="font-medium">
            {n} {n === 1 ? "concept" : "concepts"}
          </span>{" "}
          from “{importDeck.data.subject}”.
        </p>
      </div>
    );
  }

  const busy = importDeck.isPending || dismiss.isPending;

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <SubjectDot subject={item.subject} />
        <div className="min-w-0">
          <p className="truncate text-sm text-ink">
            <span className="font-medium">{from}</span> shared{" "}
            <span className="font-medium">“{item.subject}”</span>
          </p>
          <p className="text-xs text-muted">A deck of concepts for your vault</p>
          {importDeck.isError && (
            <p className="mt-1 text-xs text-review">
              Couldn't import just now. Please try again.
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="sm"
          icon={Download}
          loading={importDeck.isPending}
          disabled={busy}
          onClick={() =>
            importDeck.mutate({ shareId: item.shareId, itemId: item.id })
          }
        >
          {importDeck.isPending ? "Importing…" : "Import"}
        </Button>
        <Button
          variant="ghost"
          tone="neutral"
          size="sm"
          icon={X}
          loading={dismiss.isPending}
          disabled={busy}
          onClick={() => dismiss.mutate(item.id)}
          aria-label={`Dismiss deck shared by ${from}`}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
