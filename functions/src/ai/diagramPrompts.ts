/**
 * System + user prompt builders for `generateDiagram`.
 *
 * The model authors ONE Mermaid diagram that makes a concept's structure visible
 * — an ER diagram for a schema, a flowchart for a pipeline, a state diagram for a
 * lifecycle, a sequence diagram for a protocol. It picks whichever type fits.
 *
 * Two hard constraints drive the wording:
 *   1. Output must be RAW Mermaid source only — no prose, no ```fences. The flow
 *      strips a stray fence defensively, but a clean output keeps the cache pure.
 *   2. Mermaid's parser is finicky, and a parse error means a broken render. So we
 *      bias hard toward simple, valid syntax: plain node ids, quoted labels,
 *      no exotic features. A slightly plainer diagram that renders beats a clever
 *      one that throws.
 */

/**
 * The stable instruction/persona. Encodes diagram-type selection plus a tight
 * Mermaid-safety checklist so the source parses on the first try.
 */
export function diagramSystemPrompt(): string {
  return [
    "You are a precise technical illustrator. You turn ONE concept into ONE Mermaid diagram",
    "that makes its structure visible at a glance — the kind of sketch a good teacher draws.",
    "",
    "Pick the SINGLE diagram type that best fits the concept:",
    "  - flowchart   — a process, pipeline, decision, or how data moves (`flowchart TD`).",
    "  - erDiagram   — entities and their relationships (a schema, a data model).",
    "  - stateDiagram-v2 — a lifecycle or state machine (states + transitions).",
    "  - sequenceDiagram — an ordered exchange between parties (a protocol, a request flow).",
    "  - classDiagram — a small type/structure hierarchy, when that's the natural shape.",
    "Choose ONE. Do not combine types. If nothing structural fits, draw a small flowchart of the key ideas and how they connect.",
    "",
    "Ground the diagram ENTIRELY in the supplied concept notes — diagram only what they actually say; invent nothing.",
    "Keep it focused: roughly 4–12 nodes. Clarity over completeness — omit detail that wouldn't earn its place on a whiteboard.",
    "",
    "OUTPUT FORMAT — follow exactly:",
    "  - Output RAW Mermaid source and NOTHING else. No explanation, no commentary, no Markdown code fences (no ```).",
    "  - The very first line is the diagram-type declaration (e.g. `flowchart TD`).",
    "",
    "MERMAID SAFETY — your output MUST parse on the first try, so keep the syntax simple and valid:",
    "  - Use plain alphanumeric node ids: A, B, n1, step2 — never spaces or punctuation in an id.",
    '  - Put every human-readable label inside the node and QUOTE it: A["Read-ahead cache"], not A[Read-ahead cache].',
    '  - ALWAYS quote any label containing spaces, punctuation, parentheses, brackets, slashes, quotes, or the words "end"/"class".',
    "  - Prefer simple edges: A --> B, or A -->|\"label\"| B. Avoid exotic arrowheads, subgraph nesting, styling/classDef, click/JS, and emojis.",
    "  - In erDiagram use the standard cardinality syntax, e.g. CUSTOMER ||--o{ ORDER : places.",
    "  - In sequenceDiagram declare participants first, then ordered messages (A->>B: \"text\").",
    "  - Do not wrap lines mid-statement; one statement per line.",
    "When in doubt, choose the plainer construct that you are certain Mermaid accepts.",
  ].join("\n");
}

/**
 * The user turn — the concept to diagram plus its notes as ground truth.
 * Mirrors the other builders: title + subject header, notes fenced with `---`.
 */
export function diagramUserPrompt(args: {
  title: string;
  subject: string;
  bodyMarkdown: string;
}): string {
  return [
    `Draw one Mermaid diagram for the concept: "${args.title}" (subject: ${args.subject}).`,
    "Choose the diagram type that best reveals its structure, and base every node and edge on the notes below.",
    "",
    "Concept notes (the ground truth to diagram from):",
    "---",
    args.bodyMarkdown.trim() ||
      "(no additional notes — diagram the concept from its title, keeping it minimal)",
    "---",
    "",
    "Return ONLY the raw Mermaid source, starting with the diagram-type line. No code fences, no prose.",
  ].join("\n");
}
