/**
 * One step of `@starkeep/e2e-aws`'s app cloud run, in a child process.
 *
 * `prepare` brings the throwaway AWS test stack up to date, installs
 * Exercise, signs a fresh user in, and creates a `read` and a `readwrite`
 * delegation token for `/mcp`. `finish` deletes that user and tears the stack
 * down after a passing run, and leaves everything up after a failing one.
 * Core's `e2e-aws/README.md` describes the environment the steps read.
 *
 * The step runs in core's own process tree, through core's `tsx`, the way
 * core's example app runs it (`example-app/e2e/cloud-run-step.ts`).
 * `scripts/link-core-harness.mjs` linked the package before this run.
 */

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The repository root, which holds the manifest. */
export const APP_ROOT = resolve(here, "..", "..");

/** The run file `prepare` writes and the suite reads. Gitignored. */
export const CLOUD_RUN_FILE = join(here, ".cloud-run", "run.json");

/** What `prepare` writes: `AppCloudRun` in core's `e2e-aws/src/app-cloud-run.ts`, the fields this suite reads. */
export type CloudRun =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly appId: string;
      /** The app's root on the CloudFront distribution, ending in a slash. */
      readonly appUrl: string;
      /** The deployment's execute-api URL, where the consent pages answer. */
      readonly gatewayUrl: string;
      readonly delegationTokens: { readonly read: string; readonly readwrite: string };
    };

export function readCloudRun(): CloudRun {
  return JSON.parse(readFileSync(CLOUD_RUN_FILE, "utf8")) as CloudRun;
}

/**
 * Where `scripts/link-core-harness.mjs` linked `@starkeep/e2e-aws`, resolved
 * once and kept in the environment. `prepare` installs Exercise with
 * `npm ci`, which empties `node_modules` and removes the link, so `finish`
 * (run by the reporter, in the same process) cannot look it up again.
 */
const E2E_AWS_DIR_ENV = "EXERCISE_E2E_AWS_DIR";

function e2eAwsDir(): string {
  const known = process.env[E2E_AWS_DIR_ENV];
  if (known) return known;
  const dir = realpathSync(join(APP_ROOT, "node_modules", "@starkeep", "e2e-aws"));
  process.env[E2E_AWS_DIR_ENV] = dir;
  return dir;
}

export async function runCloudStep(args: string[]): Promise<void> {
  const e2eAws = e2eAwsDir();
  await new Promise<void>((done, fail) => {
    const child = spawn("pnpm", ["exec", "tsx", "src/app-cloud-run.ts", ...args], {
      cwd: e2eAws,
      stdio: "inherit",
    });
    child.once("error", fail);
    child.once("close", (code) =>
      code === 0 ? done() : fail(new Error(`app-cloud-run ${args[0]} exited with code ${code}`)),
    );
  });
}
