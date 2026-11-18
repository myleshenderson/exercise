import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

/** `npm run test:platform`: the DataLayer contract over a real local data server. */
export default defineConfig({
  test: {
    root: resolve(here, "..", ".."),
    include: ["starkeep/platform/*.platform.ts"],
    environment: "node",
    globalSetup: [resolve(here, "setup.ts")],
    // Booting the platform builds and starts core's daemons.
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
