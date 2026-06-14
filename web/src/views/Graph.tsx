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
 * Interactions:
 *  - Click a node → study it: /review/:id when it's due, else /learn/:id.
 *  - Filters (subject chips + a mastery-state segment) HIDE non-matching nodes
 *    and their edges, narrowing the map to what you care about right now.
 *  - The "learn next" frontier — new concepts whose prerequisites are all
 *    satisfied — gets a soft pulse so the next thing to study stands out.
 *  - "Edit links" mode turns a click into a selection that opens a side panel
 *    for adding/removing a concept's prerequisites (saved as a manual override).
 *  - Hover dims everything but the node and its neighbours.
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
import { useQueryClient } from "@tanstack/react-query";
import ForceGraph2D, {
  type ForceGraphMethods,
  type NodeObject,
} from "react-force-graph-2d";
import { Check, Pencil, Plus, Search, Share2, X } from "lucide-react";
import { clsx } from "clsx";
import type { Concept, Mastery } from "@tutor/shared";
import { useConcepts, useMastery, qk } from "../lib/firestore-hooks";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { isDue } from "../lib/format";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Eyebrow,
  Pill,
  Skeleton,
} from "../components/ui";
import {
  readThemeColors,
  subjectColor,
  withAlpha,
  type ThemeColors,
} from "../components/graph-theme";

/**
 * Default mastery threshold (`masteryThreshold` in shared domain config): a
 * prerequisite counts as "satisfied" once its mastery score reaches this. Used
 * to compute the learn-next frontier.
 */
const MASTERY_THRESHOLD = 0.6;

/** Which subset of concepts a mastery-state filter keeps. */
type MasteryFilter = "all" | "weak" | "mastered";

/** Effective prerequisites: a manual override, when set, fully replaces the
 * inferred list. Returns a fresh array so callers can treat it as owned. */
function effectivePrereqs(c: Concept): string[] {
  return c.manualPrerequisites ?? c.prerequisites ?? [];
}

/** A concept is "mastered" for filtering once its score clears the threshold. */
function isMastered(m: Mastery | undefined): boolean {
  return (m?.masteryScore ?? 0) >= MASTERY_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Graph data model — what we hand to the force layout.
// ---------------------------------------------------------------------------

interface GNode {
  id: string;
  title: string;
  subject: string;
  /** Mastery 0..1 (0 when the concept hasn't been practised yet). */
  mastery: number;
  /** Spaced-repetition status; "new" until the concept is first practised. */
  status: Mastery["status"];
  /** True when this concept is on the "learn next" frontier (see `buildGraph`). */
  frontier: boolean;
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
 * The "learn next" frontier: concepts you haven't started (`status:"new"`, which
 * includes never-practised concepts with no mastery doc) whose every effective
 * prerequisite is already satisfied (mastery score ≥ the threshold). These are
 * the concepts that are *unlocked* right now — the natural next things to study.
 *
 * Prerequisites use the manual override when present (`manualPrerequisites ??
 * prerequisites`), and only count prereqs that still exist in the vault.
 */
function computeFrontier(
  concepts: Concept[],
  masteryById: Record<string, Mastery>,
): Set<string> {
  const ids = new Set(concepts.map((c) => c.id));
  const frontier = new Set<string>();
  for (const c of concepts) {
    const status = masteryById[c.id]?.status ?? "new";
    if (status !== "new") continue;
    const prereqs = effectivePrereqs(c).filter((p) => ids.has(p) && p !== c.id);
    const ready = prereqs.every((p) => isMastered(masteryById[p]));
    if (ready) frontier.add(c.id);
  }
  return frontier;
}

/**
 * Fold concepts + mastery into a `{ nodes, links }` graph. Edges that point at
 * concepts missing from the vault are dropped, and undirected wikilinks are
 * de-duplicated (A↔B once). A prerequisite edge supersedes a plain link between
 * the same pair so we draw the more informative directed edge. Prerequisite
 * edges follow the effective list (manual override wins), so the drawn graph
 * matches what the learner has pinned.
 */
function buildGraph(
  concepts: Concept[],
  masteryById: Record<string, Mastery>,
  frontier: Set<string>,
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
    for (const to of effectivePrereqs(c)) {
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
    status: masteryById[c.id]?.status ?? "new",
    frontier: frontier.has(c.id),
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

  const masteryById = mastery.data ?? {};

  return (
    <GraphCanvas
      concepts={all}
      masteryById={masteryById}
      // Click a node to study it: review when it's due (so spaced repetition
      // takes priority), otherwise a fresh learn session.
      onOpen={(id) =>
        navigate(
          isDue(masteryById[id]?.dueDate) ? `/review/${id}` : `/learn/${id}`,
        )
      }
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
  const [masteryFilter, setMasteryFilter] = useState<MasteryFilter>("all");
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Edit mode turns a node click into a *selection* (opens the prereq editor)
  // instead of navigating to study it. `selectedId` is the concept being edited.
  const [editMode, setEditMode] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const subjects = useMemo(
    () => [...new Set(concepts.map((c) => c.subject))].sort((a, b) => a.localeCompare(b)),
    [concepts],
  );

  // The learn-next frontier is computed from the *full* vault — a node stays a
  // frontier node regardless of the active filters (its prereqs may be hidden).
  const frontier = useMemo(
    () => computeFrontier(concepts, masteryById),
    [concepts, masteryById],
  );

  // Apply the filter bar by actually narrowing the concept set, so non-matching
  // nodes (and any edges touching them) are hidden, not just dimmed.
  const visibleConcepts = useMemo(() => {
    return concepts.filter((c) => {
      if (subject !== ALL && c.subject !== subject) return false;
      if (masteryFilter === "weak" && isMastered(masteryById[c.id])) return false;
      if (masteryFilter === "mastered" && !isMastered(masteryById[c.id]))
        return false;
      return true;
    });
  }, [concepts, masteryById, subject, masteryFilter]);

  const data = useMemo(
    () => buildGraph(visibleConcepts, masteryById, frontier),
    [visibleConcepts, masteryById, frontier],
  );

  const frontierCount = useMemo(
    () => data.nodes.filter((n) => n.frontier).length,
    [data],
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

  // Concept lookup by id for the editor panel (titles, prereqs).
  const conceptById = useMemo(() => {
    const m = new Map<string, Concept>();
    for (const c of concepts) m.set(c.id, c);
    return m;
  }, [concepts]);

  // If the selected concept scrolls out of the visible set (e.g. the filter
  // changes), keep the panel open only while its node is still on screen.
  const visibleIds = useMemo(
    () => new Set(data.nodes.map((n) => n.id)),
    [data],
  );
  useEffect(() => {
    if (selectedId && !visibleIds.has(selectedId)) setSelectedId(null);
  }, [selectedId, visibleIds]);

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

  // Hover (and, while editing, the selected node) focuses the map: the active
  // node + its neighbours stay lit, everything else dims back. Filtering already
  // removed off-subject / off-state nodes, so this is purely a focus aid.
  const focusId = hoverId ?? selectedId;
  const isDimmed = useCallback(
    (id: string): boolean => {
      if (focusId && id !== focusId && !neighbors.get(focusId)?.has(id))
        return true;
      return false;
    },
    [focusId, neighbors],
  );

  const linkDimmed = useCallback(
    (l: GLink): boolean => {
      const s = typeof l.source === "object" ? (l.source as GNode).id : l.source;
      const t = typeof l.target === "object" ? (l.target as GNode).id : l.target;
      if (focusId && s !== focusId && t !== focusId) return true;
      return false;
    },
    [focusId],
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
      const selected = selectedId === n.id;
      // Hubs read slightly larger; clamp so nothing dominates.
      const r = 3 + Math.min(4, n.degree * 0.5);
      const alpha = dim ? 0.18 : 1;
      const ringR = r + 2.4;

      // Frontier glow: a soft accent halo behind unlocked "learn next" nodes so
      // the things you're ready to study draw the eye. Skipped while dimmed.
      if (n.frontier && !dim) {
        const glowR = ringR + 4.5;
        ctx.beginPath();
        ctx.arc(x, y, glowR, 0, 2 * Math.PI);
        ctx.fillStyle = withAlpha(theme.accent, 0.14);
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = withAlpha(theme.accent, 0.5);
        ctx.beginPath();
        ctx.arc(x, y, glowR, 0, 2 * Math.PI);
        ctx.stroke();
      }

      // Mastery ring (track + fill arc).
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
      if (hovered || selected) {
        // A crisp ring marks the node under the cursor or the one being edited.
        ctx.lineWidth = selected ? 2 : 1.5;
        ctx.strokeStyle = selected
          ? withAlpha(theme.accent, 0.95)
          : withAlpha(theme.ink, 0.55);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.stroke();
      }

      // Label: shown when zoomed in, or always for the focused node, frontier
      // nodes, and hubs — the things most worth naming at a glance.
      const showLabel =
        !dim && (hovered || selected || n.frontier || scale > 1.4 || n.degree >= 6);
      if (showLabel) {
        const fontSize = Math.max(2.5, 11 / scale);
        ctx.font = `${fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = withAlpha(theme.ink, hovered || selected ? 1 : 0.78);
        ctx.fillText(n.title, x, y + ringR + 1.5);
      }
    },
    [isDimmed, hoverId, selectedId, theme],
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
      if (!id) return;
      // Edit mode: a click selects the concept for prerequisite editing (and
      // toggles off if it's already selected). Otherwise, study the concept.
      if (editMode) setSelectedId((cur) => (cur === id ? null : id));
      else onOpen(id);
    },
    [editMode, onOpen],
  );

  // Clicking empty canvas clears the current selection.
  const handleBackgroundClick = useCallback(() => setSelectedId(null), []);

  const toggleEditMode = useCallback(() => {
    setEditMode((on) => {
      if (on) setSelectedId(null); // leaving edit mode closes the panel
      return !on;
    });
  }, []);

  // Saving prereqs writes the manual override and refetches concepts so the
  // graph redraws with the new edges. The query key is per-user.
  const qc = useQueryClient();
  const { user } = useAuth();
  const handleSaved = useCallback(() => {
    void qc.invalidateQueries({ queryKey: qk.concepts(user?.uid ?? "anon") });
  }, [qc, user?.uid]);

  const selectedConcept = selectedId
    ? (conceptById.get(selectedId) ?? null)
    : null;

  return (
    <div className="animate-fade flex h-[calc(100vh-9rem)] min-h-[28rem] flex-col">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-[2rem] leading-none tracking-tight text-ink">
            Graph
          </h1>
          <p className="mt-1.5 text-[0.95rem] text-muted">
            {data.nodes.length} concepts · {data.links.length} connections.{" "}
            {editMode
              ? "Click a node to edit its prerequisites."
              : "Click a node to study it."}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {subjects.length > 1 && (
            <SubjectFilter
              subjects={subjects}
              value={subject}
              onChange={setSubject}
            />
          )}
          <MasteryStateFilter value={masteryFilter} onChange={setMasteryFilter} />
          <button
            onClick={toggleEditMode}
            aria-pressed={editMode}
            title="Add or remove prerequisites by clicking a concept"
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors",
              editMode
                ? "border-accent/30 bg-accent/10 text-accent"
                : "border-border bg-surface text-muted hover:text-ink",
            )}
          >
            <Pencil size={13} />
            Edit links
          </button>
        </div>
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
              onBackgroundClick={handleBackgroundClick}
              onEngineStop={() => fgRef.current?.zoomToFit(400, 60)}
              cooldownTicks={120}
              d3VelocityDecay={0.32}
              enableNodeDrag
            />
          )}
        </div>

        <Legend
          frontierCount={frontierCount}
          onReset={() => fgRef.current?.zoomToFit(400, 60)}
        />

        {selectedConcept && (
          <PrereqEditor
            key={selectedConcept.id}
            concept={selectedConcept}
            concepts={concepts}
            onClose={() => setSelectedId(null)}
            onSaved={handleSaved}
          />
        )}
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

function MasteryStateFilter({
  value,
  onChange,
}: {
  value: MasteryFilter;
  onChange: (v: MasteryFilter) => void;
}) {
  const opts: { key: MasteryFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "weak", label: "Weak" },
    { key: "mastered", label: "Mastered" },
  ];
  return (
    <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1">
      {opts.map((o) => (
        <FilterChip
          key={o.key}
          active={value === o.key}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </FilterChip>
      ))}
    </div>
  );
}

function Legend({
  frontierCount,
  onReset,
}: {
  frontierCount: number;
  onReset: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-3">
      <div className="pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface/85 px-2.5 py-1.5 text-[0.7rem] text-muted backdrop-blur-sm">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-accent" aria-hidden />
          ring = mastery
        </span>
        {frontierCount > 0 && (
          <span className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-full bg-accent/20 ring-1 ring-accent/50"
              aria-hidden
            />
            learn next ({frontierCount})
          </span>
        )}
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
// Prerequisite editor — a quiet panel for pinning a concept's prerequisites.
// Shows the effective list (manual override wins) by title, lets you add from
// the rest of the vault or remove existing ones, then saves the full desired
// list as a manual override via `setPrerequisites`.
// ---------------------------------------------------------------------------

function PrereqEditor({
  concept,
  concepts,
  onClose,
  onSaved,
}: {
  concept: Concept;
  concepts: Concept[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = useMemo(
    // Defensive: a concept can never be its own prerequisite.
    () => effectivePrereqs(concept).filter((id) => id !== concept.id),
    [concept],
  );
  const [draft, setDraft] = useState<string[]>(initial);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of concepts) m.set(c.id, c.title);
    return m;
  }, [concepts]);

  const draftSet = useMemo(() => new Set(draft), [draft]);

  // Candidates to add: every other concept not already pinned, ranked by title,
  // filtered by the search box. Self is excluded so a concept can't require
  // itself. Capped so the list stays light.
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return concepts
      .filter(
        (c) =>
          c.id !== concept.id &&
          !draftSet.has(c.id) &&
          (q === "" ||
            c.title.toLowerCase().includes(q) ||
            c.subject.toLowerCase().includes(q)),
      )
      .sort(
        (a, b) =>
          a.subject.localeCompare(b.subject) || a.title.localeCompare(b.title),
      )
      .slice(0, 30);
  }, [concepts, concept.id, draftSet, query]);

  const add = (id: string) => {
    if (id === concept.id || draftSet.has(id)) return;
    setDraft((d) => [...d, id]);
    setQuery("");
  };
  const remove = (id: string) => setDraft((d) => d.filter((x) => x !== id));

  // Dirty when the desired set differs from what's stored (order-insensitive).
  const dirty = useMemo(() => {
    if (draft.length !== initial.length) return true;
    const init = new Set(initial);
    return draft.some((id) => !init.has(id));
  }, [draft, initial]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.setPrerequisites({
        conceptId: concept.id,
        // Send the full desired list; the server stores it as the override.
        prerequisites: draft.filter((id) => id !== concept.id),
      });
      onSaved();
      onClose();
    } catch {
      setError("Couldn't save. Please try again.");
      setSaving(false);
    }
  };

  return (
    <div className="pointer-events-auto absolute inset-x-3 bottom-16 top-3 z-10 ml-auto flex max-h-[calc(100%-5rem)] w-auto flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm sm:inset-y-3 sm:left-auto sm:right-3 sm:w-80">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <Eyebrow>Prerequisites</Eyebrow>
          <h2 className="mt-1 truncate font-serif text-lg leading-tight text-ink">
            {concept.title}
          </h2>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: subjectColor(concept.subject) }}
              aria-hidden
            />
            <span className="truncate">{concept.subject}</span>
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="-mr-1 -mt-1 shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-ink/[0.05] hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {/* Current prerequisites */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-muted">
              Learn first ({draft.length})
            </span>
            {concept.manualPrerequisites && (
              <Pill tone="accent">manual</Pill>
            )}
          </div>
          {draft.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted">
              No prerequisites. Add the concepts that should come first.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {draft.map((id) => (
                <li
                  key={id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border bg-bg px-2.5 py-1.5"
                >
                  <span className="min-w-0 truncate text-sm text-ink">
                    {titleById.get(id) ?? (
                      <span className="text-muted">Unknown concept</span>
                    )}
                  </span>
                  <button
                    onClick={() => remove(id)}
                    aria-label={`Remove ${titleById.get(id) ?? "prerequisite"}`}
                    className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-review/10 hover:text-review"
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Add a prerequisite */}
        <div>
          <span className="mb-2 block text-xs font-medium text-muted">
            Add a prerequisite
          </span>
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search concepts…"
              className="w-full rounded-lg border border-border bg-bg py-1.5 pl-8 pr-2.5 text-sm text-ink placeholder:text-muted focus:border-accent/40 focus:outline-none focus:ring-2 focus:ring-accent/20"
            />
          </div>
          <ul className="mt-2 max-h-44 space-y-1 overflow-y-auto">
            {candidates.length === 0 ? (
              <li className="px-1 py-1.5 text-xs text-muted">
                {query.trim()
                  ? "No matching concepts."
                  : "Every other concept is already a prerequisite."}
              </li>
            ) : (
              candidates.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => add(c.id)}
                    className="group flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent/[0.06]"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: subjectColor(c.subject) }}
                        aria-hidden
                      />
                      <span className="truncate text-sm text-ink">
                        {c.title}
                      </span>
                    </span>
                    <Plus
                      size={14}
                      className="shrink-0 text-muted transition-colors group-hover:text-accent"
                    />
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      </div>

      {/* Footer actions */}
      <div className="border-t border-border px-4 py-3">
        {error && <p className="mb-2 text-xs text-review">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" tone="neutral" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            icon={Check}
            loading={saving}
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </div>
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
