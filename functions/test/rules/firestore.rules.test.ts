/**
 * Security-rules tests for firestore.rules.
 *
 * The invariant under test (CONTRACTS §2): a signed-in user touches ONLY their
 * own `users/{uid}/**`. Concepts, mastery, and explanationCache are
 * client-READ-ONLY — written exclusively by Cloud Functions (admin SDK), so a
 * client can never forge a grade or mastery score. Sessions and the user
 * profile doc are owner read/write. A different uid is denied across the
 * subtree; unauthenticated is denied everywhere.
 *
 * Runs under `firebase emulators:exec` (see the `test:rules` npm script), so a
 * Firestore emulator is available. Host/port are read from firebase.json, with
 * a 127.0.0.1:8080 default.
 *
 * We use `withSecurityRulesDisabled` to SEED docs that only Functions may write
 * (concepts/mastery/cache), then assert the client can read but not write them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, deleteDoc } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const PROJECT_ID = "demo-tutor";
const ALICE = "alice";
const BOB = "bob";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

function readFirestoreRules(): string {
  return readFileSync(resolve(repoRoot, "firestore.rules"), "utf8");
}

/** Read the Firestore emulator host/port from firebase.json, default 127.0.0.1:8080. */
function firestoreHostPort(): { host: string; port: number } {
  try {
    const fb = JSON.parse(readFileSync(resolve(repoRoot, "firebase.json"), "utf8"));
    const port = fb?.emulators?.firestore?.port;
    if (typeof port === "number") return { host: "127.0.0.1", port };
  } catch {
    // fall through to default
  }
  return { host: "127.0.0.1", port: 8080 };
}

/** Path helpers — mirror shared/src/firestore-paths.ts (kept inline to avoid coupling the test to app code). */
const p = {
  user: (uid: string) => `users/${uid}`,
  concept: (uid: string, id: string) => `users/${uid}/concepts/${id}`,
  mastery: (uid: string, id: string) => `users/${uid}/mastery/${id}`,
  cache: (uid: string, key: string) => `users/${uid}/explanationCache/${key}`,
  session: (uid: string, id: string) => `users/${uid}/sessions/${id}`,
};

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFirestoreRules(), ...firestoreHostPort() },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  // Seed the Functions-only docs (bypassing rules) so we can test client READS.
  await testEnv.withSecurityRulesDisabled(async (ctx: RulesTestContext) => {
    const db = ctx.firestore();
    await setDoc(doc(db, p.concept(ALICE, "c1")), { id: "c1", title: "Indexing" });
    await setDoc(doc(db, p.mastery(ALICE, "c1")), { conceptId: "c1", masteryScore: 0.4 });
    await setDoc(doc(db, p.cache(ALICE, "c1_standard")), { conceptId: "c1", markdown: "..." });
    // Bob owns his own concept too, used for cross-user read checks.
    await setDoc(doc(db, p.concept(BOB, "c9")), { id: "c9", title: "Joins" });
  });
});

describe("owner — users/{uid} profile + sessions (read/write allowed)", () => {
  it("can read and write own profile doc", async () => {
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertSucceeds(setDoc(doc(db, p.user(ALICE)), { uid: ALICE, displayName: "Alice" }));
    await assertSucceeds(getDoc(doc(db, p.user(ALICE))));
  });

  it("can read and write own sessions", async () => {
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertSucceeds(
      setDoc(doc(db, p.session(ALICE, "s1")), { id: "s1", startedAt: "2026-06-13T00:00:00Z" }),
    );
    await assertSucceeds(getDoc(doc(db, p.session(ALICE, "s1"))));
    await assertSucceeds(deleteDoc(doc(db, p.session(ALICE, "s1"))));
  });
});

describe("owner — concepts/mastery/cache are READ-ONLY (only Functions write)", () => {
  it("can READ own concept but CANNOT write it", async () => {
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertSucceeds(getDoc(doc(db, p.concept(ALICE, "c1"))));
    await assertFails(setDoc(doc(db, p.concept(ALICE, "c1")), { title: "hacked" }));
    await assertFails(setDoc(doc(db, p.concept(ALICE, "c2")), { title: "new" }));
    await assertFails(deleteDoc(doc(db, p.concept(ALICE, "c1"))));
  });

  it("can READ own mastery but CANNOT write it (no client-forged scores)", async () => {
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertSucceeds(getDoc(doc(db, p.mastery(ALICE, "c1"))));
    await assertFails(
      setDoc(doc(db, p.mastery(ALICE, "c1")), { conceptId: "c1", masteryScore: 1 }),
    );
    await assertFails(deleteDoc(doc(db, p.mastery(ALICE, "c1"))));
  });

  it("can READ own explanationCache but CANNOT write it", async () => {
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertSucceeds(getDoc(doc(db, p.cache(ALICE, "c1_standard"))));
    await assertFails(
      setDoc(doc(db, p.cache(ALICE, "c1_standard")), { conceptId: "c1", markdown: "x" }),
    );
  });
});

describe("cross-user — a different uid is denied across the subtree", () => {
  it("Bob cannot read or write Alice's profile", async () => {
    const db = testEnv.authenticatedContext(BOB).firestore();
    await assertFails(getDoc(doc(db, p.user(ALICE))));
    await assertFails(setDoc(doc(db, p.user(ALICE)), { uid: ALICE }));
  });

  it("Bob cannot read Alice's concepts/mastery/cache", async () => {
    const db = testEnv.authenticatedContext(BOB).firestore();
    await assertFails(getDoc(doc(db, p.concept(ALICE, "c1"))));
    await assertFails(getDoc(doc(db, p.mastery(ALICE, "c1"))));
    await assertFails(getDoc(doc(db, p.cache(ALICE, "c1_standard"))));
  });

  it("Bob cannot write into Alice's sessions or anywhere in her subtree", async () => {
    const db = testEnv.authenticatedContext(BOB).firestore();
    await assertFails(setDoc(doc(db, p.session(ALICE, "s1")), { id: "s1" }));
    await assertFails(getDoc(doc(db, p.session(ALICE, "s1"))));
  });

  it("Bob CAN read/write his own subtree (sanity check the rule is uid-scoped, not deny-all)", async () => {
    const db = testEnv.authenticatedContext(BOB).firestore();
    await assertSucceeds(getDoc(doc(db, p.concept(BOB, "c9")))); // read own concept
    await assertSucceeds(setDoc(doc(db, p.session(BOB, "s1")), { id: "s1" })); // write own session
  });
});

describe("unauthenticated — denied everywhere", () => {
  it("cannot read or write any document", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, p.user(ALICE))));
    await assertFails(getDoc(doc(db, p.concept(ALICE, "c1"))));
    await assertFails(getDoc(doc(db, p.mastery(ALICE, "c1"))));
    await assertFails(getDoc(doc(db, p.session(ALICE, "s1"))));
    await assertFails(setDoc(doc(db, p.session(ALICE, "s1")), { id: "s1" }));
    await assertFails(setDoc(doc(db, p.user(ALICE)), { uid: ALICE }));
  });
});
