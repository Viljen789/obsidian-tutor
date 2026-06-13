import { defineConfig } from "tsup";

// Bundles src/index.ts + the workspace `@tutor/shared` source into a single
// CommonJS file in lib/. The Firebase runtime installs the externals below from
// package.json; everything else (shared types, zod, parsers) is inlined, which
// sidesteps workspace-symlink issues at deploy time.
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "lib",
  format: ["cjs"],
  target: "node20",
  platform: "node",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ["firebase-admin", "firebase-functions", "@anthropic-ai/sdk", "@google/genai"],
  // The workspace package has no published build — it MUST be inlined, never
  // required at runtime (its TS source would fail Node's ESM resolver).
  noExternal: ["@tutor/shared"],
});
