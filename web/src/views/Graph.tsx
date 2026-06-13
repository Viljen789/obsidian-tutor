/**
 * Graph (/graph): the vault as a living concept map. Every imported concept is a
 * node; the wikilink graph (`links`) draws quiet undirected edges and inferred
 * `prerequisites` draw directional, dashed "learn-this-first" edges. A node's
 * fill is its subject's calm hue, and a ring around it fills with mastery — so a
 * glance shows both what connects to what and how far along you are.
 *
 * Built on `react-force-graph-2d` (a canvas force-directed layout). Canvas can't
 * use Tailwind, so colours come from the live theme tokens via `graph-theme.ts`,
 * keeping the view in step with light/dark mode and the rest of the palette.
 *
 * Interactions: click a node → /learn/:conceptId; hover dims everything but the
 * node and its neighbours; a subtle subject filter focuses one subject at a time.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import ForceGraph2D, {
  type ForceGraphMethods,
  type NodeObject,
} from "react-force-graph-2d";
import { Share2 } from "lucide-react";
import { clsx } from "clsx";
import type { Concept, Mastery } from "@tutor/shared";
import { useConcepts, useMastery } from "../lib/firestore-hooks";
import { Button, Card, EmptyState, ErrorState, Skeleton } from "../components/ui";
import {
  readThemeColors,
  subjectColor,
  withAlpha,
  type ThemeColors,
} from "../components/graph-theme";

// ---------------------------------------------------------------------------
// Graph data model — what we hand to the force layout.
// ---------------------------------------------------------------------------

interface GNode {
  id: string;
  title: string;
  subject: string;
  /** Mastery 0..1 (0 when the concept hasn't been practised yet). */
  mastery: number;
  color: string;
  /** Degree, used to scale node size so hubs read as larger. */
  degree: number;
}

interface GLink {
  source: string;
  target: string;
  /** `link` = undirected wikilink; `prereq` = directed "learn first" edge. */
  kind: "link" | "prereq";
}

type GraphData = { nodes: GNode[]; links: GLink[] };

const ALL = "__all__";

/**
 * Fold concepts + mastery into a `{ nodes, links }` graph. Edges that point at
 * concepts missing from the vault are dropped, and undirected wikilinks are
 * de-duplicated (A↔B once). A prerequisite edge supersedes a plain link between
 * the same pair so we draw the more informative directed edge.
 */
function buildGraph(
  concepts: Concept[],
  masteryById: Record<string, Mastery>,
): GraphData {
  const ids = new Set(concepts.map((c) => c.id));
  const degree = new Map<string, number>();
  const bump = (a: string, b: string) => {
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
  };

  // Directed prerequisite edges first so they win over plain links.
  const links: GLink[] = [];
  const seen = new Set<string>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  for (const c of concepts) {
    for (const to of c.prerequisites ?? []) {
      if (!ids.has(to) || to === c.id) continue;
      const key = pairKey(c.id, to);
      if (seen.has(key)) continue;
      seen.add(key);
      // Edge points from prerequisite -> dependent ("learn `to` before `c`").
      links.push({ source: to, target: c.id, kind: "prereq" });
      bump(c.id, to);
    }
  }
  for (const c of concepts) {
    for (const to of c.links ?? []) {
      if (!ids.has(to) || to === c.id) continue;
      const key = pairKey(c.id, to);
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: c.id, target: to, kind: "link" });
      bump(c.id, to);
    }
  }

  const nodes: GNode[] = concepts.map((c) => ({
    id: c.id,
    title: c.title,
    subject: c.subject,
    mastery: Math.max(0, Math.min(1, masteryById[c.id]?.masteryScore ?? 0)),
    color: subjectColor(c.subject),
    degree: degree.get(c.id) ?? 0,
  }));

  return { nodes, links };
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function Graph() {
  const navigate = useNavigate();
  const concepts = useConcepts();
  const mastery = useMastery();

  if (concepts.isPending || mastery.isPending) return <GraphSkeleton />;

  if (concepts.isError) {
    return (
      <div className="animate-fade space-y-6">
        <Header />
        <Card>
          <ErrorState onRetry={() => void concepts.refetch()} />
        </Card>
      </div>
    );
  }

  const all = concepts.data ?? [];
  if (all.length === 0) {
    return (
      <div className="animate-fade space-y-6">
        <Header />
        <Card>
          <EmptyState
            icon={Share2}
            title="No graph to draw yet"
            description="Import a vault to see your concepts and how they link together."
            action={<Button onClick={() => navigate("/import")}>Import a vault</Button>}
          />
        </Card>
      </div>
    );
  }

  return (
    <GraphCanvas
      concepts={all}
      masteryById={mastery.data ?? {}}
      onOpen={(id) => navigate(`/learn/${id}`)}
    />
  );
}

// ---------------------------------------------------------------------------
// Canvas — kept separate so all the force-graph wiring lives behind the
// loading/empty gates above and only mounts once there's data to draw.
// ---------------------------------------------------------------------------

function GraphCanvas({
  concepts,
  masteryById,
  onOpen,
}: {
  concepts: Concept[];
  masteryById: Record<string, Mastery>;
  onOpen: (conceptId: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // The force-graph ref type is generic and awkward; narrow to the methods we
  // call (`zoomToFit`, `d3Force`) and keep the JSX prop clean.
  const fgRef = useRef<ForceGraphMethods<GNode, GLink> | undefined>(undefined);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [theme, setTheme] = useState<ThemeColors>(() => readThemeColors());
  const [subject, setSubject] = useState<string>(ALL);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const subjects = useMemo(
    () => [...new Set(concepts.map((c) => c.subject))].sort((a, b) => a.localeCompare(b)),
    [concepts],
  );

  const data = useMemo(
    () => buildGraph(concepts, masteryById),
    [concepts, masteryById],
  );

  // Adjacency for hover highlighting (node id -> set of neighbour ids).
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const n of data.nodes) m.set(n.id, new Set());
    for (const l of data.links) {
      m.get(l.source)?.add(l.target);
      m.get(l.target)?.add(l.source);
    }
    return m;
  }, [data]);

  // Which node ids the subject filter keeps "active" (full opacity).
  const subjectActive = useMemo(() => {
    if (subject === ALL) return null;
    return new Set(
      data.nodes.filter((n) => n.subject === subject).map((n) => n.id),
    );
  }, [data, subject]);

  // Size the canvas to the container and track resize.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () =>
      setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-read theme colours when the user toggles light/dark (the `.dark` class
  // on <html> flips the CSS variables underneath the canvas).
  useEffect(() => {
    const sync = () => setTheme(readThemeColors());
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => mo.disconnect();
  }, []);

  // Gentle spacing: ease the charge/link forces so clusters breathe a little.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force("charge")?.strength(-130);
    const link = fg.d3Force("link");
    if (link && "distance" in link) {
      (link as unknown as { distance: (d: number) => void }).distance(48);
    }
  }, [data]);

  const isDimmed = useCallback(
    (id: string): boolean => {
      if (subjectActive && !subjectActive.has(id)) return true;
      if (hoverId && id !== hoverId && !neighbors.get(hoverId)?.has(id))
        return true;
      return false;
    },
    [subjectActive, hoverId, neighbors],
  );

  const linkDimmed = useCallback(
    (l: GLink): boolean => {
      const s = typeof l.source === "object" ? (l.source as GNode).id : l.source;
      const t = typeof l.target === "object" ? (l.target as GNode).id : l.target;
      if (subjectActive && !(subjectActive.has(s) && subjectActive.has(t)))
        return true;
      if (hoverId && s !== hoverId && t !== hoverId) return true;
      return false;
    },
    [subjectActive, hoverId],
  );

  // Custom node paint: subject-coloured dot + a mastery ring + a label that
  // appears once you're zoomed in (or for the hovered/neighbour nodes).
  const paintNode = useCallback(
    (node: NodeObject<GNode>, ctx: CanvasRenderingContext2D, scale: number) => {
      const n = node as GNode & NodeObject<GNode>;
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      const dim = isDimmed(n.id);
      const hovered = hoverId === n.id;
      // Hubs read slightly larger; clamp so nothing dominates.
      const r = 3 + Math.min(4, n.degree * 0.5);
      const alpha = dim ? 0.18 : 1;

      // Mastery ring (track + fill arc).
      const ringR = r + 2.4;
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = withAlpha(theme.border, dim ? 0.25 : 0.9);
      ctx.beginPath();
      ctx.arc(x, y, ringR, 0, 2 * Math.PI);
      ctx.stroke();
      if (n.mastery > 0) {
        ctx.strokeStyle = withAlpha(theme.accent, alpha);
        ctx.beginPath();
        ctx.arc(x, y, ringR, -Math.PI / 2, -Math.PI / 2 + n.mastery * 2 * Math.PI);
        ctx.stroke();
      }

      // Node body.
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = dim ? withAlpha(n.color, 0.2) : n.color;
      ctx.fill();
      if (hovered) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = withAlpha(theme.ink, 0.55);
        ctx.stroke();
      }

      // Label: shown when zoomed in, or always for hovered node + neighbours.
      const showLabel = !dim && (hovered || scale > 1.4 || n.degree >= 6);
      if (showLabel) {
        const fontSize = Math.max(2.5, 11 / scale);
        ctx.font = `${fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = withAlpha(theme.ink, hovered ? 1 : 0.78);
        ctx.fillText(n.title, x, y + ringR + 1.5);
      }
    },
    [isDimmed, hoverId, theme],
  );

  // Hit area for pointer events (so the whole node + ring is clickable).
  const paintNodePointer = useCallback(
    (node: NodeObject<GNode>, color: string, ctx: CanvasRenderingContext2D) => {
      const n = node as GNode & NodeObject<GNode>;
      const r = 3 + Math.min(4, n.degree * 0.5) + 3;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
      ctx.fill();
    },
    [],
  );

  const linkColor = useCallback(
    (l: GLink): string => {
      const dim = linkDimmed(l);
      const base = l.kind === "prereq" ? theme.review : theme.muted;
      return withAlpha(base, dim ? 0.08 : l.kind === "prereq" ? 0.5 : 0.32);
    },
    [linkDimmed, theme],
  );

  const handleHover = useCallback((node: NodeObject<GNode> | null) => {
    setHoverId(node ? ((node as GNode).id ?? null) : null);
    document.body.style.cursor = node ? "pointer" : "";
  }, []);

  const handleClick = useCallback(
    (node: NodeObject<GNode>) => {
      const id = (node as GNode).id;
      if (id) onOpen(id);
    },
    [onOpen],
  );

  return (
    <div className="animate-fade flex h-[calc(100vh-9rem)] min-h-[28rem] flex-col">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-[2rem] leading-none tracking-tight text-ink">
            Graph
          </h1>
          <p className="mt-1.5 text-[0.95rem] text-muted">
            {data.nodes.length} concepts · {data.links.length} connections.
            Click a node to study it.
          </p>
        </div>
        {subjects.length > 1 && (
          <SubjectFilter
            subjects={subjects}
            value={subject}
            onChange={setSubject}
          />
        )}
      </div>

      <Card className="relative flex-1 overflow-hidden">
        <div ref={wrapRef} className="absolute inset-0">
          {size.width > 0 && (
            <ForceGraph2D<GNode, GLink>
              ref={fgRef}
              width={size.width}
              height={size.height}
              graphData={data}
              backgroundColor="rgba(0,0,0,0)"
              nodeRelSize={4}
              nodeCanvasObject={paintNode}
              nodePointerAreaPaint={paintNodePointer}
              nodeLabel={(n) => (n as GNode).title}
              linkColor={linkColor}
              linkWidth={(l) => ((l as GLink).kind === "prereq" ? 1.2 : 0.8)}
              linkLineDash={(l) =>
                (l as GLink).kind === "prereq" ? [3, 2] : null
              }
              linkDirectionalArrowLength={(l) =>
                (l as GLink).kind === "prereq" ? 3 : 0
              }
              linkDirectionalArrowRelPos={1}
              linkDirectionalArrowColor={linkColor}
              onNodeHover={handleHover}
              onNodeClick={handleClick}
              onEngineStop={() => fgRef.current?.zoomToFit(400, 60)}
              cooldownTicks={120}
              d3VelocityDecay={0.32}
              enableNodeDrag
            />
          )}
        </div>

        <Legend onReset={() => fgRef.current?.zoomToFit(400, 60)} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls + legend (kept subtle, floating over the canvas corners).
// ---------------------------------------------------------------------------

function SubjectFilter({
  subjects,
  value,
  onChange,
}: {
  subjects: string[];
  value: string;
  onChange: (s: string) => void;
}) {
  return (
    <div className="flex max-w-full flex-wrap items-center gap-1 rounded-xl border border-border bg-surface p-1">
      <FilterChip active={value === ALL} onClick={() => onChange(ALL)}>
        All
      </FilterChip>
      {subjects.map((s) => (
        <FilterChip key={s} active={value === s} onClick={() => onChange(s)}>
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: subjectColor(s) }}
            aria-hidden
          />
          <span className="max-w-[10rem] truncate">{s}</span>
        </FilterChip>
      ))}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
        active ? "bg-ink/[0.06] text-ink" : "text-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function Legend({ onReset }: { onReset: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-3">
      <div className="pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface/85 px-2.5 py-1.5 text-[0.7rem] text-muted backdrop-blur-sm">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-accent" aria-hidden />
          ring = mastery
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-px w-4 bg-muted" aria-hidden />
          link
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-px w-4 border-t border-dashed border-review"
            aria-hidden
          />
          prerequisite
        </span>
      </div>
      <button
        onClick={onReset}
        className="pointer-events-auto rounded-lg border border-border bg-surface/85 px-2.5 py-1.5 text-[0.7rem] font-medium text-muted backdrop-blur-sm transition-colors hover:text-ink"
      >
        Reset view
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton.
// ---------------------------------------------------------------------------

function GraphSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-12 w-40" />
      <Skeleton className="h-[28rem] w-full rounded-2xl" />
    </div>
  );
}

function Header() {
  return (
    <header>
      <h1 className="font-serif text-[2rem] leading-none tracking-tight text-ink">
        Graph
      </h1>
      <p className="mt-1.5 text-[0.95rem] text-muted">
        Your concepts and how they connect.
      </p>
    </header>
  );
}
