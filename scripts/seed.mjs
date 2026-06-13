/**
 * Packs the checked-in `sample-vault/` into `sample-vault.zip` at the repo root,
 * ready to upload through the app's Import screen (or via `npm run smoke`).
 *
 *   npm run seed
 */
import AdmZip from "adm-zip";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const VAULT = path.join(ROOT, "sample-vault");
const OUT = path.join(ROOT, "sample-vault.zip");

const zip = new AdmZip();
zip.addLocalFolder(VAULT); // dotfiles (.obsidian) are ignored by the ingester
zip.writeZip(OUT);

console.log(`✓ Wrote ${path.relative(ROOT, OUT)} (${zip.getEntries().length} entries)`);
console.log("  Upload it on the app's Import screen, or run `npm run smoke` with the");
console.log("  emulator running to exercise the full ingest → teach → grade loop.");
