import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

/** `npm run test:cloud`: `/mcp` on the throwaway AWS test stack. */
export default defineConfig({
  test: {
    root: resolve(here, "..", ".."),
    include: ["starkeep/cloud/*.cloud.ts"],
    environment: "node",
    globalSetup: [resolve(here, "setup.ts")],
    reporters: ["default", resolve(here, "finish-reporter.ts")],
    // `prepare` deploys the stack before any test runs; each test makes a
    // few calls through CloudFront and the gateway, some to a cold Lambda.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
