/**
 * ShareView (/share/:shareId) — the PUBLIC, read-only viewer for a shared deck.
 *
 * This page renders OUTSIDE the app shell and the auth gate (see App.tsx): a
 * signed-out visitor opening a share link lands straight here. So it must stand
 * entirely on its own — its own slim header, its own reading column, no nav, no
 * dependency on a logged-in user.
 *
 * It reads the snapshot client-side with a one-shot getDoc against the public
 * `shares/{shareId}` doc (Firestore rules allow public read; no auth needed).
 * The doc is a frozen snapshot the createShare callable wrote — title + subject
 * + explanation markdown only, nothing private.
 *
 * Each concept's markdown renders through <Markdown> WITHOUT a `resolveWiki`, so
 * any `[[wikilinks]]` degrade to quiet text rather than in-app links that would
 * bounce a signed-out reader into the auth gate.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { doc, getDoc } from "firebase/firestore";
import { BookOpen, Layers } from "lucide-react";
import { paths, type ShareDoc } from "@tutor/shared";
import { db } from "../lib/firebase";
import { Card, EmptyState, Eyebrow, Spinner, SubjectDot } from "../components/ui";
import { Markdown } from "../components/Markdown";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "ready"; doc: ShareDoc };

export function ShareView() {
  const { shareId } = useParams<{ shareId: string }>();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    if (!shareId) {
      setState({ status: "not-found" });
      return;
    }
    setState({ status: "loading" });
    void (async () => {
      try {
        const snap = await getDoc(doc(db, paths.shareDoc(shareId)));
        if (!active) return;
        if (!snap.exists()) {
          setState({ status: "not-found" });
          return;
        }
        setState({ status: "ready", doc: snap.data() as ShareDoc });
      } catch {
        // A read failure on a public doc is indistinguishable, to the reader,
        // from a link that no longer exists — present it the same calm way.
        if (active) setState({ status: "not-found" });
      }
    })();
    return () => {
      active = false;
    };
  }, [shareId]);

  return (
    <div className="flex min-h-full flex-col bg-bg">
      <ShareHeader />
      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-10">
        {state.status === "loading" && (
          <div className="flex justify-center py-20">
            <Spinner label="Opening the deck…" />
          </div>
        )}

        {state.status === "not-found" && (
          <Card className="mt-8">
            <EmptyState
              icon={Layers}
              title="This deck isn't available"
              description="The link may be mistyped, or the deck may have been removed by its owner."
              action={
                <Link
                  to="/"
                  className="text-sm font-medium text-accent transition-opacity hover:opacity-80"
                >
                  Make your own — try Tutor
                </Link>
              }
            />
          </Card>
        )}

        {state.status === "ready" && <ShareBody doc={state.doc} />}
      </main>

      <ShareFooter />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header — a slim standalone wordmark; deliberately not the app's NavLink shell.
// ---------------------------------------------------------------------------

function ShareHeader() {
  return (
    <header className="border-b border-border bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-2xl items-center justify-between gap-3 px-5">
        <div className="flex items-center gap-2.5 text-ink">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent/10 text-accent">
            <BookOpen size={16} />
          </span>
          <span className="font-serif text-lg tracking-tight">Tutor</span>
        </div>
        <Eyebrow>Shared deck</Eyebrow>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Body — the deck masthead + each concept's title and explanation.
// ---------------------------------------------------------------------------

function ShareBody({ doc }: { doc: ShareDoc }) {
  const count = doc.concepts.length;
  return (
    <article className="animate-fade">
      <header className="mb-10">
        <div className="flex items-center gap-2">
          <SubjectDot subject={doc.subject} />
          <Eyebrow>Read-only deck</Eyebrow>
        </div>
        <h1 className="mt-3 font-serif text-4xl leading-tight tracking-tight text-ink">
          {doc.subject}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {doc.ownerName ? <>Shared by {doc.ownerName} · </> : null}
          {count} {count === 1 ? "concept" : "concepts"}
        </p>
      </header>

      <div className="space-y-12">
        {doc.concepts.map((concept) => (
          <section key={concept.id}>
            <h2 className="mb-3 font-serif text-2xl tracking-tight text-ink">
              {concept.title}
            </h2>
            {/* No resolveWiki: wikilinks render as quiet text, never in-app
                links that would bounce a signed-out reader to the auth gate. */}
            <Markdown>{concept.markdown}</Markdown>
          </section>
        ))}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Footer — a quiet invitation back to the product.
// ---------------------------------------------------------------------------

function ShareFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-5 py-6 text-sm text-muted">
        <span>A read-only deck shared from Tutor.</span>
        <Link
          to="/"
          className="font-medium text-accent transition-opacity hover:opacity-80"
        >
          Make your own — try Tutor
        </Link>
      </div>
    </footer>
  );
}
