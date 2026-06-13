import { defineConfig } from "vitest/config";

// Pure unit tests only (engine, ingest parsing) — no emulator required.
// Security-rules tests run separately via `npm run test:rules` (see vitest.rules.config.ts).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
