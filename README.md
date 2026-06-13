# Tutor — your Obsidian vault, taught back to you

A single-user web app that ingests your Obsidian study vault, turns it into a
concept graph, and teaches you one concept at a time with intuition-first
explanations, generated questions, honest partial-credit grading, and a
spaced-repetition learner model that adapts what you see next.

- **Frontend:** React + Vite + TypeScript + Tailwind (Firebase Hosting)
- **Auth:** Firebase Authentication (Google)
- **Data:** Cloud Firestore — concepts, concept graph, learner model
- **Server logic:** Firebase Cloud Functions (2nd gen, TS) — all Claude calls + grading + sequencing
- **AI:** Anthropic Claude (strong model for teaching/grading, cheap model for classification)

See [`CONTRACTS.md`](CONTRACTS.md) for the architecture and the interfaces every
part is built against.

## Quick start (local, no cloud account needed)

Prereqs: Node ≥ 20, Java (for the emulators), the Firebase CLI.

```bash
npm install

# 1) Add your Anthropic key for the AI functions (local only, gitignored):
cp functions/.secret.local.example functions/.secret.local
#   then edit functions/.secret.local and paste your key

# 2) Build the functions once (the emulator runs the bundled output):
npm -w functions run build

# 3) Start the Firebase Emulator Suite (auth, firestore, functions, storage, hosting):
firebase emulators:start --project demo-tutor

# 4) In another terminal, start the web app + functions rebuild-on-save:
npm run dev
#   → open http://localhost:5173
```

The app defaults to the emulators with a demo project, so it runs fully offline.

## Going live (Firebase)

1. Create a Firebase project; enable Authentication (Google), Firestore, Storage, Functions.
2. `firebase use --add <your-project-id>` (replaces the `demo-tutor` default).
3. Set the production secret: `firebase functions:secrets:set ANTHROPIC_API_KEY`.
4. Put your web app config in `web/.env` (`VITE_USE_EMULATORS=false` + the `VITE_FIREBASE_*` vars).
5. `npm run build && firebase deploy`.

## Useful commands

```bash
npm run typecheck                # shared + functions + web
npm -w functions run test        # engine + ingestion + integration unit tests
npm -w functions run test:rules  # Firestore security-rules tests (ephemeral emulator)
npm run seed                     # pack sample-vault/ → sample-vault.zip for upload
npm run smoke                    # drive the full live loop against a running emulator
```

### Verify the whole loop locally

```bash
npm -w functions run build               # build the functions bundle
firebase emulators:start --project demo-tutor   # terminal 1
npm run smoke                            # terminal 2 — auth → upload → ingest → nextItem
```

`npm run smoke` exercises the real path end-to-end. The ingest + sequencer steps
need no API key; the explain/grade steps light up once `functions/.secret.local`
holds a valid `ANTHROPIC_API_KEY` (restart the emulator after adding it).

## Project status

All build phases are complete and verified (`CONTRACTS.md §8`):

- **Contracts & foundation** — workspaces compile, share one type set, emulators boot.
- **Ingestion** — markdown/YAML + wikilink parser, graph assembly, prerequisite
  inference (heuristic + LLM), idempotent `ingestVault`.
- **Backend** — Firestore security rules (concepts/mastery client-read-only) with
  10 passing rules tests; the four Claude callables with the key in Secret Manager.
- **Adaptive engine** — SM-2, mastery, prerequisite-gated sequencer; 38 deterministic tests.
- **Frontend** — dashboard / teach / review / progress, hint-before-answer, live mastery.
- **Integration** — the full teach→grade→update→next loop, the sample vault, and
  idempotent re-import verified live on the emulator (`npm run smoke`).

The one step that needs your own Anthropic key is the live explain/grade calls —
everything else runs offline against the emulator.
