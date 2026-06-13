import { defineConfig } from "vitest/config";

// Security-rules tests — run under `firebase emulators:exec` so a Firestore/
// Storage emulator is available (see the `test:rules` npm script). Kept separate
// from the default unit-test run, which must not require an emulator.
export default defineConfig({
  test: {
    include: ["test/rules/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
  },
});
