# CONTRACTS.md — the shared interface every agent builds against

This is the **frozen contract** for the Adaptive Obsidian Tutor. The authoritative
types live in [`shared/src`](shared/src) and are imported by both `web/` and
`functions/` as `@tutor/shared`. If you need to change a contract, **escalate to
the Orchestrator** — do not fork it locally.

> Golden rule: types are the contract. Read [`shared/src/domain.ts`](shared/src/domain.ts),
> [`shared/src/api.ts`](shared/src/api.ts), and the typed stub modules in
> [`functions/src`](functions/src) before writing code.

---

## 1. Repo layout

```
shared/      @tutor/shared — domain + API types + Firestore path builders (source of truth)
functions/   Cloud Functions (2nd gen, TS). Bundled to lib/ with tsup (CJS).
  src/config.ts          model ids + token caps + defaults (swap models HERE only)
  src/lib/firebase.ts     Firestore data-access layer (use these helpers; don't reinvent)
  src/lib/callable.ts     authedCallable() wrapper — auth + Zod + secrets
  src/ingest/             Phase 1 — vault → concept graph     (typed stubs)
  src/ai/                 Phase 2 — explain/questions/hint/grade (typed stubs)
  src/flows/submitAnswer  Phase 2 — grade + mastery update flow (typed stub)
  src/engine/             Phase 3 — SM-2 / mastery / sequencer  (typed stubs)
web/         React + Vite + TS + Tailwind. Firebase Hosting target.
  src/lib/firebase.ts     client init + emulator wiring
  src/lib/api.ts          fully-typed callable client (api.explainConcept(...) etc.)
  src/lib/auth.tsx        AuthProvider + useAuth() (Google sign-in)
sample-vault/  seed content (Phase 1/5)
scripts/       seed + helpers
```

## 2. Firestore schema & paths

Use the builders in [`shared/src/firestore-paths.ts`](shared/src/firestore-paths.ts) — never hand-build a path.

| Path | Doc type | Written by | Client access |
|---|---|---|---|
| `users/{uid}` | `UserProfile` + `{ settings: UserSettings }` | client | read/write own |
| `users/{uid}/concepts/{conceptId}` | `Concept` | **Functions only** | read-only |
| `users/{uid}/mastery/{conceptId}` | `Mastery` | **Functions only** | read-only |
| `users/{uid}/sessions/{sessionId}` | `Session` | client | read/write own |
| `users/{uid}/explanationCache/{conceptId}_{depth}` | `ExplanationCacheEntry` | **Functions only** | read-only |

**Security model** (see [`firestore.rules`](firestore.rules)): a user touches only
their own `users/{uid}/**`. Concepts/mastery/cache are written exclusively by Cloud
Functions (admin SDK bypasses rules) — so grading and mastery are **never
client-trusted**. Storage uploads are scoped to `users/{uid}/**` (≤ 50 MB).

**Timestamp convention:** stored as **ISO-8601 strings** (`IsoTimestamp`) at the
domain layer. The adaptive engine takes explicit `nowMs` (epoch ms) so it stays pure.

## 3. Cloud Function callables (the API)

All are **authenticated callables** (`onCall`) wrapped by `authedCallable`. No request
carries a `uid` (it comes from auth). Names are registered in `CALLABLE`
([`shared/src/api.ts`](shared/src/api.ts)); request/response types live there too.

| Callable | Request → Response | Owner |
|---|---|---|
| `ingestVault` | `IngestVaultRequest → IngestVaultResponse` | Phase 1 |
| `explainConcept` | `ExplainConceptRequest → ExplainConceptResponse` | Phase 2 |
| `generateQuestions` | `GenerateQuestionsRequest → GenerateQuestionsResponse` | Phase 2 |
| `submitAnswer` | `SubmitAnswerRequest → SubmitAnswerResponse` | Phase 2 (composes Phase 3) |
| `requestHint` | `RequestHintRequest → RequestHintResponse` | Phase 2 |
| `nextItem` | `NextItemRequest → NextItem` | Phase 3 |

The client calls these via the typed `api` object in [`web/src/lib/api.ts`](web/src/lib/api.ts).

## 4. Module interfaces (fill the bodies, keep the signatures)

- **Phase 1 — `functions/src/ingest/index.ts`**: `parseNote`, `assembleGraph` (pure),
  and the `ingestVault` callable. Idempotent upsert via `upsertConcepts` (never wipes mastery).
- **Phase 2 — `functions/src/ai/index.ts`**: `explainConcept`, `generateQuestions`,
  `requestHint` callables + `gradeAnswer(args)` helper. Plus `flows/submitAnswer.ts`.
  Use `getAnthropic()` (Phase 0 provides it) and `MODELS`/`TOKEN_CAPS` from `config.ts`.
- **Phase 3 — `functions/src/engine/index.ts`**: `updateSm2`, `newMastery`, `applyGrade`,
  `selectNextItem` (all **pure**), plus the `nextItem` callable. Deterministic given `nowMs`.

## 5. Adaptive policy (the spec, restated precisely)

1. **Due first.** Any concept with `dueDate <= now` → `action: "review"`.
2. **Else learn.** The next `status:"new"` concept whose every prerequisite has
   `masteryScore >= settings.masteryThreshold` → `action: "learn"`. Respect `dailyNewLimit`.
3. **Else none.** Nothing due and nothing unlocked → `action: "none"` (+ `blocked` list).
4. **Depth** adapts to mastery: `deep` for new/weak, `standard` mid, `refresher` for high mastery.
- **SM-2:** map the 0–5 quality from grading → update `easeFactor`, `intervalDays`,
  `repetitions`, recompute `dueDate`. Strong answer lengthens interval; weak (`q<3`) resets to ~1 day.

## 6. Conventions & guardrails

- **Secrets:** Anthropic key only via `defineSecret("ANTHROPIC_API_KEY")`, bound to AI
  callables. Never in client code or the repo. Local emulator reads `functions/.secret.local`.
- **Cost:** check `explanationCache` before calling the model; obey `TOKEN_CAPS`; use the
  cheap `MODELS.classify` for prerequisite inference.
- **Idempotent ingestion:** re-import upserts concepts by id; mastery is untouched.
- **Tests:** Phase 3 (engine, Vitest) and Phase 2 (security rules, `@firebase/rules-unit-testing`)
  must have automated tests. Pure functions take injected time — no `Date.now()` inside them.
- **Imports:** extensionless relative imports (`./foo`, not `./foo.js`).

## 7. Dev commands

```bash
npm install                 # all workspaces
npm run typecheck           # shared + functions + web
npm -w functions run build  # tsup bundle → functions/lib
npm -w functions run test   # vitest
npm -w web run build         # tsc + vite
firebase emulators:start --project demo-tutor   # auth/firestore/functions/storage/hosting/ui
npm run dev                 # web (5173) + functions tsup --watch
```

## 8. Phases, owners, acceptance gates

| Phase | Owner | Gate |
|---|---|---|
| 0 | Orchestrator | types compile + importable by both; emulators boot ✅ |
| 1 | Ingestion agent | sample vault → correct concept docs + navigable graph; both subjects + links |
| 2 | Backend agent | rules tests pass (no cross-user); each callable returns contract-shaped output on emulator |
| 3 | Tutor-logic agent | unit tests: due-priority, prereq gating, interval growth/reset; deterministic |
| 4 | Frontend agent | sign in → see due → get taught → answer → mastery updates live |
| 5 | QA agent | fresh user: upload → first lesson → second session with spaced reviews; no manual DB edits |
