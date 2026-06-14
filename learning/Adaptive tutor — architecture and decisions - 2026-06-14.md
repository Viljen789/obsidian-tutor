---
last: 2026-06-14
commit: 6a52462
tags: [project-teacher, learning, tutor, firebase, spaced-repetition, llm]
---

# Adaptive Obsidian tutor — architecture and decisions

> [!NOTE]
> **Context**: Written after Waves 2 and 3 shipped (flashcards, FSRS, tutor chat, mock exams, graph navigation, analytics, sharing, PWA, streaming). It explains *why* the system is shaped the way it is, so you can reason about it — and defend the choices in an exam or interview. Reflects the repo at commit `6a52462`.

## Code index

The whole system is three workspaces. Read them in this order:

- [shared/src/domain.ts](shared/src/domain.ts) — the domain model (Concept, Mastery, Question, …). **The single source of truth.**
- [shared/src/api.ts](shared/src/api.ts) — every callable's request/response types + the `CALLABLE` name registry.
- [shared/src/firestore-paths.ts](shared/src/firestore-paths.ts) — canonical Firestore paths (nobody hand-builds a path).
- [functions/src/engine/](functions/src/engine/) — the **pure** adaptive engine: `fsrs.ts` (scheduler), `mastery.ts` (`applyGrade`), `sequencer.ts` (`selectNextItem`). No I/O, no clock.
- [functions/src/lib/llm.ts](functions/src/lib/llm.ts) + [lib/gemini.ts](functions/src/lib/gemini.ts) — the pluggable LLM provider.
- [functions/src/lib/callable.ts](functions/src/lib/callable.ts) — `authedCallable` (auth + Zod + secrets in one place).
- [functions/src/flows/](functions/src/flows/) — the orchestration callables (submitAnswer, generateMock, tutorChat, createShare, …).
- [functions/src/ingest/](functions/src/ingest/) — vault → concept graph (parse, prereq inference, image assets).
- [web/src/components/Lesson.tsx](web/src/components/Lesson.tsx) — the teach → question → grade loop, the heart of the UI.
- [web/src/lib/streamExplain.ts](web/src/lib/streamExplain.ts) — streaming explanations with a fallback.

## 1. Project overview

The app turns a folder of **Obsidian markdown notes** into a personal tutor. The loop is:

1. **Ingest** a vault (zip upload or GitHub repo) → parse notes → build a graph of *concepts* with prerequisite edges.
2. **Teach** one concept at a time: an LLM writes an intuition-first explanation, then generates questions.
3. **Grade** your free-text answers (server-side, never client-trusted) and update a per-concept *mastery* score.
4. **Schedule** the next review with a spaced-repetition algorithm (now **FSRS**), and pick "what to learn next" with a prerequisite-gated sequencer.

Everything runs on **free tiers** (Google AI Studio Gemini + Firebase Spark/Blaze with a $1 budget alert). That single constraint — *$0* — shaped almost every decision below.

## 2. Architecture and logic

Three layers, one contract:

```
          ┌──────────────────────── @tutor/shared ────────────────────────┐
          │   domain types · API request/response types · Firestore paths │
          └───────────────▲───────────────────────────────▲──────────────┘
                          │ imported by both              │
          ┌───────────────┴───────────┐       ┌───────────┴────────────────┐
          │  web/  (React + Vite)     │       │  functions/ (Cloud Funcs)   │
          │  - reads Firestore direct │       │  - authedCallable wrappers  │
          │  - calls callables (api)  │──────▶│  - pure engine (FSRS/seq)   │
          │  - never trusts itself    │ onCall│  - LLM provider (Gemini)    │
          └───────────────────────────┘       └──────────────┬──────────────┘
                          ▲                                   │ admin SDK
                          │ realtime reads                    ▼
                          └──────────────  Firestore  ◀───────┘  (rules: client
                                         Storage / Auth         reads, Functions write)
```

The **teach → grade → schedule** loop, end to end:

```
 user answers ─▶ submitAnswer (callable)
                    │  1. gradeAnswer()  ── Gemini grades free text → {quality 0-5, score 0-1}
                    │  2. applyGrade()   ── PURE: FSRS updates stability/difficulty → next dueDate
                    │  3. setMastery()   ── persist new learner state
                    ▼
              returns {grade, mastery}  ─▶ UI shows feedback + live progress
                    ▲
 "what next?" ──── nextItem (callable) ── selectNextItem(): due reviews first,
                                          else the next unlocked new concept
```

Two ideas make this tractable:

- **Contract-first.** `shared/` holds the types; `web/` and `functions/` both import them, so the client *cannot* call a function with the wrong shape — it's a compile error. When we added 8 new callables across Waves 2–3, each started life as a type in `api.ts`.
- **A pure engine.** All the scheduling math (`fsrs.ts`, `mastery.ts`, `sequencer.ts`) takes time as an argument (`nowMs`) and does no I/O. That's why it has **187 unit tests** and zero mocks — you can test "a lapse shortens the interval to ~1 day" deterministically.

## 3. Key technical decisions

### Server-trusted grading and mastery (the security model)
Concepts and mastery are written **only** by Cloud Functions (the admin SDK bypasses Firestore rules); the client has read-only access. So a user can't forge a mastery score by editing a Firestore doc — grading and the SM-2/FSRS math live server-side. The client *reads* its data directly (fast, realtime) but *mutates* only through callables.

### A pure, swappable scheduler (SM-2 → FSRS)
The engine was built behind a frozen signature: `applyGrade(mastery, quality, score, nowMs, masteredThreshold) → Mastery`. Wave 3 swapped the internals from **SM-2** to **FSRS-4.5** (the algorithm Anki adopted) without touching a single caller (`submitAnswer`, `reviewCard`, `nextItem`). FSRS tracks two latent variables — *stability* (how long memory lasts) and *difficulty* — and schedules to a target 90% recall. The 0–5 grade is mapped to FSRS's 4 buttons (Again/Hard/Good/Easy).

### Pluggable LLM provider + the truncation gotcha
`lib/llm.ts` picks a provider from an env var; the rest of the backend calls `completeText` / `completeStructured` / `streamText` and never touches an SDK. The hard-won bug: Gemini 2.5 Flash's "thinking" eats the output-token budget and **truncates JSON mid-string**. The fix lives in one place — `thinkingConfig: { thinkingBudget: 0 }` in `lib/gemini.ts`. (This is also why we *stayed* on `gemini-2.5-flash`: Gemini 3 replaced that knob with `thinking_level`, which can't fully disable thinking.)

### Streaming explanations via streaming callables
Explanations are long (~8 s to generate). Instead of a raw `onRequest` + SSE endpoint (which needs manual CORS + token verification), Wave 3 uses **Firebase streaming callables**: the handler's `response.sendChunk()` pushes text as Gemini produces it. First chunk arrives in ~0.6 s. The client hook ([streamExplain.ts](web/src/lib/streamExplain.ts)) renders progressively and **falls back to the plain `explainConcept` callable** on any error — so an explanation always loads.

### Caching everywhere, because $0
Every model call is money (even on free tier it's rate-limited). So explanations and flashcard decks are cached in Firestore keyed by `(conceptId, depth)`; `explainConcept` checks the cache before spending a call. Combined with a jittered **429 backoff** in `lib/gemini.ts`, the app rides the free tier without falling over.

### Multi-agent orchestration (how it was *built*)
Each wave followed the same shape: the orchestrator froze the contract (shared types, callable registration, routes, rules, typed stubs), then fanned out specialist agents in **disjoint file lanes** (no two agents touch the same file), then integrated and ran one authoritative typecheck/test/build gate before deploying. Correctness-critical bits (FSRS, the engine fixes) stayed with the orchestrator.

### Trade-offs and alternatives
- **`tsup` inlines `@tutor/shared` into the functions bundle** instead of shipping it as a runtime dependency. Why: the cloud `npm install` can't resolve a workspace package, and the TS source would fail Node's resolver. Trade-off: the shared code is duplicated into the bundle, but deploys "just work."
- **Client reads Firestore directly** rather than routing every read through a callable. Trade-off: gives up a layer of indirection for realtime updates + lower latency + fewer function invocations (cost). Safe because rules make those collections read-only.
- **FSRS over BKT / staying on SM-2.** Bayesian Knowledge Tracing is more principled but needs per-skill parameters and training data we don't have; SM-2 is simpler but measurably worse. FSRS is the pragmatic middle — strong defaults, no training, drops in behind the existing interface.
- **Streaming callables over SSE.** SSE/`onRequest` would work in any browser but adds CORS + manual auth + a public-invoker surface. Streaming callables reuse the existing auth + a one-line client API; the cost is depending on a newer Firebase feature (mitigated by the fallback).
- **Shared decks are public-by-unguessable-id**, not access-controlled. Trade-off: simpler (no per-viewer auth) and fine for opt-in study sharing; the snapshot deliberately excludes all private data (mastery, history).
- **The $0 constraint** ruled out streaming-first models, Pro-tier models, and managed vector search. We accepted the free-tier "data used for training" terms as the price of $0.

---
## Version history
- **2026-06-14**: Initial creation, after Waves 2 & 3 (commit `6a52462`).

## Reflection questions

Try to answer these out loud — they're the parts most worth understanding:

1. The adaptive engine takes `nowMs` as an argument instead of calling `Date.now()` internally. Name **two** concrete things this buys you, and one thing it costs.
2. `submitAnswer` grades *and* updates mastery in one server-side callable. What specifically goes wrong if you instead let the client grade and then write the mastery score itself?
3. FSRS slotted in behind `applyGrade` without changing `submitAnswer`, `reviewCard`, or `nextItem`. What property of the original design made that possible — and where would it have *failed* if `Mastery`'s shape had leaked SM-2 concepts like `easeFactor` into the callables?
4. Explanations are cached by `(conceptId, depth)`. Why does the streaming endpoint *still* check the cache first, and what does it send when there's a hit?
5. The sequencer prefers `manualPrerequisites ?? prerequisites`. Walk through what happens to "what should I learn next?" the moment a learner removes a wrong prerequisite edge in the graph.
6. Shared decks are readable by anyone with the link. Enumerate the fields that are copied into the public snapshot and argue why none of them leak something private.
7. If Google killed the Gemini free tier tomorrow, which files would you touch to move to a different provider, and which parts of the app would *not* need to change at all?
