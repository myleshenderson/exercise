import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { loadHarness } from "./harness.js";

declare module "vitest" {
  export interface ProvidedContext {
    ldsUrl: string;
  }
}

/**
 * Vitest global setup: boot a local Starkeep platform from starkeep-core's
 * source, in a throwaway state directory, and hand its data server's URL to
 * the suite. Each test then installs its own copy of Exercise into it.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { startPlatformStack } = await loadHarness();
  const stack = await startPlatformStack({ appParentDirs: [dirname(appDir)], drive: false });
  project.provide("ldsUrl", stack.lds.url);
  return () => stack.stop();
}
