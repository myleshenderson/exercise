/**
 * The Starkeep DataLayer contract (`src/data/starkeep/dataLayerContract.ts`)
 * over a real local data server, the one starkeep-core's tier-2 harness boots
 * (`setup.ts`). `npm test` runs the same suite over the in-memory fake.
 *
 * Every test gets an empty store: Exercise's tables installed under a new app
 * id, so each test has its own tables. The install leaves out the manifest's
 * compute section, which the DataLayer never uses, so the suite does not
 * depend on the server half's routes passing the platform's validator. The
 * transport signs each request with that install's credential, as the app's
 * signing proxy does.
 */
import { inject } from "vitest";
import manifest from "../../starkeep.manifest.json" with { type: "json" };
import { describeDataLayerContract } from "../../src/data/starkeep/dataLayerContract.js";
import { loadHarness } from "./harness.js";

let installs = 0;

/** Exercise's manifest without its compute section: the tables, and nothing the DataLayer does not use. */
const { compute: _compute, ...tablesOnly } = manifest.infraRequirements;

describeDataLayerContract("local data server", async () => {
  const { installAppDirect } = await loadHarness();
  const app = await installAppDirect(inject("ldsUrl"), {
    ...manifest,
    id: `exercise-t${++installs}`,
    infraRequirements: tablesOnly,
  });
  return (path, init) =>
    app.fetch(path, {
      method: init.method,
      headers: init.headers as Record<string, string> | undefined,
      body: typeof init.body === "string" ? init.body : undefined,
    });
});
