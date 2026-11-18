/**
 * The two pieces of starkeep-core's tier-2 harness (`@starkeep/e2e`) that the
 * platform suite uses. `scripts/link-core-harness.mjs` links the harness from
 * a starkeep-core checkout before `npm run test:platform`; `package.json`
 * never names it, because it is unpublished. The import is dynamic, so
 * `npm run typecheck` passes on a machine without the link.
 */

export interface PlatformStack {
  lds: { url: string };
  stop(): Promise<void>;
}

export interface LdsApp {
  appId: string;
  hmacSecret: string;
  dataServerUrl: string;
  fetch(path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response>;
}

interface Harness {
  startPlatformStack(options: { appParentDirs: string[]; drive?: boolean }): Promise<PlatformStack>;
  installAppDirect(ldsUrl: string, manifest: Record<string, unknown>): Promise<LdsApp>;
}

const HARNESS = "@starkeep/e2e";

export function loadHarness(): Promise<Harness> {
  return import(HARNESS) as Promise<Harness>;
}
