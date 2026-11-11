// @vitest-environment node
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defaultSleep } from "./http.js";
import { createNodeSyncDeps } from "./nodeDeps.js";
import type { SyncEnv } from "./runner.js";

const ENV: SyncEnv = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "srk",
  SYNC_OWNER_USER_ID: "owner",
  GARMIN_API_KEY: "g",
  PELOTON_AUTH0_CLIENT_ID: null,
  CREDENTIALS_KEY: null,
  PELOTON_REFRESH_TOKEN: null,
  SYNC_DEFAULT_TIMEZONE: "America/New_York",
};

describe("createNodeSyncDeps", () => {
  it("wires the store, fetch and real sleep, and passes the env through", () => {
    const deps = createNodeSyncDeps(ENV);
    expect(deps.env).toBe(ENV);
    expect(deps.sleep).toBe(defaultSleep);
    expect(typeof deps.fetch).toBe("function");
    expect(typeof deps.store.getSyncState).toBe("function");
  });

  it("without CREDENTIALS_KEY, the box rejects any use (a Garmin-only run never needs it)", async () => {
    const { box } = createNodeSyncDeps(ENV);
    await expect(box.encrypt("secret")).rejects.toThrow("CREDENTIALS_KEY is not set");
  });

  it("with CREDENTIALS_KEY, the box round-trips a secret", async () => {
    const { box } = createNodeSyncDeps({ ...ENV, CREDENTIALS_KEY: randomBytes(32).toString("base64") });
    expect(await box.decrypt(await box.encrypt("refresh-token"))).toBe("refresh-token");
  });
});
