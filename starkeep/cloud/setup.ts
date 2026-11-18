import { APP_ROOT, CLOUD_RUN_FILE, runCloudStep } from "./run-step.js";

/**
 * Vitest global setup: prepare the cloud test stack. `STARKEEP_AWS_TESTS=1`
 * enables the run; without it the step writes a disabled run file and the
 * suite skips every test.
 *
 * "Leg Day" is a button only a signed-in user sees: the first sign-in seeds
 * the default days, and Home lists them.
 */
export default async function setup(): Promise<void> {
  await runCloudStep(["prepare", "--app-dir", APP_ROOT, "--out", CLOUD_RUN_FILE, "--signed-in-control", "Leg Day"]);
}
