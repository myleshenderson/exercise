import type { Reporter, TestRunEndReason } from "vitest/node";
import { CLOUD_RUN_FILE, runCloudStep } from "./run-step.js";

/**
 * Close the cloud run once the suite's outcome is known. A reporter, because
 * a global teardown never learns whether the tests passed. A passing run
 * deletes its user and tears the stack down as `STARKEEP_AWS_TEARDOWN` says;
 * a failing run leaves everything up for debugging.
 */
export default class CloudFinishReporter implements Reporter {
  async onTestRunEnd(_modules: unknown, _errors: unknown, reason: TestRunEndReason): Promise<void> {
    await runCloudStep(["finish", "--out", CLOUD_RUN_FILE, reason === "passed" ? "--passed" : "--failed"]);
  }
}
