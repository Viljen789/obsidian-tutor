/**
 * Concept diagram panel — an LLM-authored Mermaid sketch of a concept's
 * structure (ER, flowchart, state machine, sequence, …), rendered inline.
 *
 * Quiet by default: collapsed it's a single "Show a diagram" invitation; on
 * expand it fetches `api.generateDiagram({ conceptId })` (cached per concept on
 * the backend) and renders the Mermaid client-side.
 *
 * Two deliberate choices:
 *   - mermaid is DYNAMICALLY imported inside the render effect, so the (large)
 *     library never lands in the main/entry bundle — only learners who open a
 *     diagram pay for it.
 *   - Mermaid syntax is finicky; a parse error degrades GRACEFULLY to a friendly
 *     note plus the raw source in a <pre>, so the panel is never blank and never
 *     crashes the Lesson.
 *
 * Theming follows the app's dark mode (reads `document.documentElement` for the
 * `dark` class) and respects `tone` so it sits naturally in Learn or Review.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Network, RotateCcw, Workflow } from "lucide-react";
import type { GenerateDiagramResponse } from "@tutor/shared";
import { api } from "../lib/api";
import { Button, Card, ErrorState, Eyebrow, Skeleton, type Tone } from "./ui";

export function DiagramPanel({
  conceptId,
  tone = "accent",
}: {
  conceptId: string;
  tone?: Tone;
}) {
  const [open, setOpen] = useState(false);

  const diagram = useQuery({
    queryKey: ["diagram", conceptId],
    enabled: open,
    retry: 0,
    queryFn: (): Promise<GenerateDiagramResponse> => api.generateDiagram({ conceptId }),
  });

  // Collapsed: a single quiet invitation. Offered, never forced — and the fetch
  // (a model call on a cache miss) only fires once a learner actually asks.
  if (!open) {
    return (
      <Card className="animate-rise">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-ink/[0.02] sm:px-6"
        >
          <span
            className={
              "grid h-9 w-9 shrink-0 place-items-center rounded-xl " +
              (tone === "review" ? "bg-review/10 text-review" : "bg-accent/10 text-accent")
            }
          >
            <Workflow size={18} />
          </span>
          <span className="min-w-0">
            <span className="block font-serif text-[1.05rem] leading-tight text-ink">
              Show a diagram
            </span>
            <span className="mt-0.5 block text-sm text-muted">
              See this concept's structure as a picture — entities, flow, or states.
            </span>
          </span>
        </button>
      </Card>
    );
  }

  return (
    <Card className="animate-rise overflow-hidden">
      <div className="p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Network
              size={15}
              className={tone === "review" ? "text-review" : "text-accent"}
            />
            <Eyebrow tone={tone}>Diagram</Eyebrow>
          </div>
          <div className="flex items-center gap-3">
            {diagram.isSuccess && (
              <Button
                variant="ghost"
                tone={tone}
                size="sm"
                icon={RotateCcw}
                onClick={() => diagram.refetch()}
                loading={diagram.isFetching}
                className="!px-2"
              >
                Regenerate
              </Button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs text-muted transition-colors hover:text-ink"
            >
              Close
            </button>
          </div>
        </div>

        <div className="mt-4">
          {/* Loading — a calm placeholder shaped like a diagram, never a blank box. */}
          {(diagram.isLoading || (diagram.isFetching && !diagram.data)) && (
            <DiagramSkeleton />
          )}

          {diagram.isError && (
            <ErrorState
              title="Couldn't draw this"
              description="The diagram artist is unavailable right now. You can try again in a moment."
              onRetry={() => diagram.refetch()}
            />
          )}

          {diagram.data && <MermaidView code={diagram.data.mermaid} tone={tone} />}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// MermaidView — lazily loads mermaid and renders the source to inline SVG.
// ---------------------------------------------------------------------------

/** Monotonic counter so every render gets a unique, collision-free element id. */
let RENDER_SEQ = 0;

function MermaidView({ code, tone }: { code: string; tone: Tone }) {
  // null = still rendering; { svg } = success; { error } = parse failure (we
  // then show the friendly fallback + raw source rather than a blank/crash).
  const [state, setState] = useState<
    { svg: string } | { error: true } | null
  >(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);

    (async () => {
      try {
        // Dynamic import keeps mermaid out of the main/entry bundle — only this
        // effect, which runs after the panel is opened, pulls it in.
        const mermaid = (await import("mermaid")).default;

        // Theme tracks the app's dark mode at render time. securityLevel "strict"
        // sanitises the generated SVG, so injecting it via dangerouslySetInnerHTML
        // is safe (and lets us style it responsively).
        const isDark = document.documentElement.classList.contains("dark");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: isDark ? "dark" : "default",
        });

        const id = `diagram-${conceptRenderId()}`;
        const { svg } = await mermaid.render(id, code);
        if (!cancelled) setState({ svg });
      } catch {
        // Mermaid throws on a syntax error (the model occasionally emits invalid
        // source). Degrade gracefully instead of blanking or crashing the Lesson.
        if (!cancelled) setState({ error: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  // Still rendering (the dynamic import + parse) — keep the calm placeholder.
  if (state === null) return <DiagramSkeleton />;

  // Parse failure — friendly note + the raw Mermaid source, so it's never blank.
  if ("error" in state) {
    return (
      <div className="animate-fade">
        <p className="text-sm leading-relaxed text-muted">
          We couldn't render this diagram. Here's the underlying source in case
          it's still useful — try{" "}
          <span className="font-medium text-ink">Regenerate</span> for a fresh
          one.
        </p>
        <pre className="mt-3 max-h-72 overflow-auto rounded-xl border border-border bg-bg/60 p-4 text-xs leading-relaxed text-ink">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  // Success — inject the sanitised SVG and make it responsive (full-width, centered).
  return (
    <div
      ref={containerRef}
      className={
        "animate-fade flex justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full " +
        (tone === "review" ? "text-review" : "text-accent")
      }
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  );
}

/** A unique id per render call — avoids Mermaid id collisions across panels. */
function conceptRenderId(): number {
  RENDER_SEQ += 1;
  return RENDER_SEQ;
}

// ---------------------------------------------------------------------------
// DiagramSkeleton — a quiet, diagram-shaped loading state.
// ---------------------------------------------------------------------------

function DiagramSkeleton() {
  return (
    <div className="animate-fade flex flex-col items-center gap-4 py-6">
      <div className="flex items-center gap-3">
        <Skeleton className="h-12 w-24" />
        <Skeleton className="h-0.5 w-10" />
        <Skeleton className="h-12 w-24" />
      </div>
      <Skeleton className="h-0.5 w-16" />
      <div className="flex items-center gap-3">
        <Skeleton className="h-12 w-24" />
        <Skeleton className="h-0.5 w-10" />
        <Skeleton className="h-12 w-28" />
      </div>
    </div>
  );
}
