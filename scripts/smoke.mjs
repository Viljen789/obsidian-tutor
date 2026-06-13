/**
 * End-to-end smoke test against the running Firebase Emulator Suite. Drives the
 * REAL loop a user would:
 *
 *   sign up (auth emulator) → upload the sample vault (storage emulator)
 *   → ingestVault → nextItem → explainConcept → generateQuestions
 *   → submitAnswer → nextItem again
 *
 * Start the emulator first, then run this:
 *   firebase emulators:start --project demo-tutor      # terminal 1
 *   npm -w functions run build                          # ensure lib/ is current
 *   npm run smoke                                        # terminal 2
 *
 * The ingest + sequencer steps need NO API key. The explain/grade steps need
 * ANTHROPIC_API_KEY configured for the functions emulator (functions/.secret.local);
 * without it they are SKIPPED with a note — not counted as failures.
 */
import AdmZip from "adm-zip";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT = "demo-tutor";
const REGION = "us-central1";
const FN = `http://127.0.0.1:5001/${PROJECT}/${REGION}`;
const AUTH = `http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`;
const STORAGE = "http://127.0.0.1:9199";
const BUCKET = `${PROJECT}.appspot.com`;
const HUB = "http://127.0.0.1:4400/emulators";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAULT = path.resolve(HERE, "../sample-vault");

let coreFail = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗ ${m}\x1b[0m`); coreFail++; };
const skip = (m) => console.log(`  \x1b[33m∼ ${m}\x1b[0m`);

async function main() {
  // Preflight — is the emulator suite up?
  try {
    await fetch(HUB);
  } catch {
    console.error(
      "\nEmulator hub not reachable on :4400.\n" +
        "Start it first:  firebase emulators:start --project demo-tutor\n",
    );
    process.exit(2);
  }

  console.log("\nEnd-to-end loop on the emulator\n");

  // 1) Throwaway signed-in user.
  const sign = await (
    await fetch(AUTH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true }),
    })
  ).json();
  const { idToken, localId: uid } = sign;
  if (!idToken || !uid) return done(bad(`auth signup failed: ${JSON.stringify(sign)}`));
  ok(`signed in throwaway user ${uid}`);

  // 2) Upload the sample vault zip to the storage emulator.
  const zip = new AdmZip();
  zip.addLocalFolder(VAULT);
  const buf = zip.toBuffer();
  const objectPath = `users/${uid}/uploads/sample.zip`;
  const up = await fetch(
    `${STORAGE}/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(objectPath)}`,
    { method: "POST", headers: { "content-type": "application/zip" }, body: buf },
  );
  if (!up.ok) return done(bad(`storage upload failed: ${up.status} ${await up.text()}`));
  ok(`uploaded vault zip (${buf.length} bytes) → ${objectPath}`);

  const call = async (name, data) => {
    const res = await fetch(`${FN}/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ data }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      const e = new Error(json.error?.message ?? `HTTP ${res.status}`);
      e.payload = json;
      throw e;
    }
    return json.result;
  };

  // 3) Ingest (no key needed — prereq LLM falls back to the heuristic).
  let conceptId;
  let firstCount = 0;
  try {
    const r = await call("ingestVault", { storagePath: objectPath });
    firstCount = r.conceptCount;
    if (r.conceptCount > 0 && r.subjects.length >= 2)
      ok(`ingestVault → ${r.conceptCount} concepts, subjects: ${r.subjects.join(", ")}`);
    else bad(`ingestVault unexpected: ${JSON.stringify(r)}`);
    if (r.warnings?.length) console.log(`      (${r.warnings.length} warning(s); first: ${r.warnings[0]})`);
  } catch (e) {
    return done(bad(`ingestVault failed: ${e.message}`));
  }

  // 3b) Idempotent re-import — same vault, same user → upsert, no duplicates.
  try {
    const r2 = await call("ingestVault", { storagePath: objectPath });
    if (r2.conceptCount === firstCount)
      ok(`re-import idempotent → still ${r2.conceptCount} concepts (upsert, no duplicates)`);
    else bad(`re-import changed concept count: ${firstCount} → ${r2.conceptCount}`);
  } catch (e) {
    bad(`re-import failed: ${e.message}`);
  }

  // 4) Sequencer (no key).
  try {
    const n = await call("nextItem", {});
    if ((n.action === "learn" || n.action === "review") && n.conceptId) {
      ok(`nextItem → ${n.action}: ${n.conceptId} — "${n.reason}"`);
      conceptId = n.conceptId;
    } else bad(`nextItem unexpected: ${JSON.stringify(n)}`);
  } catch (e) {
    return done(bad(`nextItem failed: ${e.message}`));
  }

  // 5) AI loop — best-effort; needs ANTHROPIC_API_KEY in the functions emulator.
  try {
    const ex = await call("explainConcept", { conceptId, depth: "standard" });
    ex.markdown?.length ? ok(`explainConcept → ${ex.markdown.length} chars (model ${ex.model}, cached=${ex.cached})`) : bad("explainConcept empty");

    const q = await call("generateQuestions", { conceptId, count: 2 });
    ok(`generateQuestions → ${q.questions.length} (${q.questions.map((x) => x.type).join(", ")})`);

    const sub = await call("submitAnswer", {
      conceptId,
      question: q.questions[0].prompt,
      answer: "A deliberately partial answer, to exercise partial-credit grading.",
    });
    ok(`submitAnswer → quality ${sub.grade.quality}/5, mastery ${sub.mastery.masteryScore.toFixed(2)} (${sub.mastery.status}), due ${sub.mastery.dueDate}`);

    const n2 = await call("nextItem", {});
    ok(`nextItem after grading → ${n2.action}: ${n2.conceptId ?? "—"}`);
    console.log("\n  Full teach→grade→update→next loop verified live. 🎉");
  } catch (e) {
    skip(`AI steps skipped — explain/grade need the active provider's key in the functions emulator.`);
    skip(`  (${e.message})  Add GEMINI_API_KEY (or your chosen provider's key) to functions/.secret.local and restart.`);
  }

  done();
}

function done() {
  console.log(coreFail === 0 ? "\nCore loop OK (ingest + sequencer).\n" : `\n${coreFail} core failure(s).\n`);
  process.exit(coreFail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
