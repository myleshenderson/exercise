import manifest from "../../starkeep.manifest.json";
import { describeDataLayerContract } from "./starkeep/dataLayerContract";
import { createFakeTransport, type FakeTable } from "./starkeep/fakeTransport";

// The DataLayer contract over the in-memory fake row API. `npm run
// test:platform` runs the same suite over a real data server
// (`starkeep/platform/dataLayer.platform.ts`).
const tables = manifest.infraRequirements.appSpecificSyncable.tables as FakeTable[];

describeDataLayerContract("fake row API", async () => createFakeTransport(tables).transport);
