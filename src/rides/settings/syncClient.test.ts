import { createRideFixtureDb } from "../testing/fixtures";
import { SyncClientError, createFetchSyncClient, createMockSyncClient, defaultSyncClient } from "./syncClient";

const NOW = new Date("2026-11-11T17:00:00.000Z");

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

test("sync posts an empty body with the bearer and returns the results", async () => {
  const fetch = vi.fn(async () =>
    json(200, { kind: "sync", results: [{ source: "peloton", fetched: 2, upserted: 2, skipped: 0, done: true, earliestAffected: null, error: null }] }),
  );
  const client = createFetchSyncClient({ fetch, getAccessToken: async () => "tok" });
  const results = await client.sync();
  expect(results).toHaveLength(1);
  expect(fetch).toHaveBeenCalledWith("/api/sync", { method: "POST", headers: { Authorization: "Bearer tok" } });
});

test("errors carry the endpoint's text verbatim and a 500's results", async () => {
  const r = [{ source: "garmin_activities", fetched: 0, upserted: 0, skipped: 0, done: false, earliestAffected: null, error: "boom" }];
  const fetch = vi.fn(async () => json(500, { error: "Garmin login failed", results: r }));
  const client = createFetchSyncClient({ fetch, getAccessToken: async () => "tok" });
  const err = await client.sync().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SyncClientError);
  expect((err as SyncClientError).message).toBe("Garmin login failed");
  expect((err as SyncClientError).status).toBe(500);
  expect((err as SyncClientError).results).toEqual(r);

  for (const [status, error] of [
    [400, "recompute must be 'all'"],
    [401, "Invalid session"],
    [403, "Sync is limited to the owner account"],
    [503, "Auth service unavailable"],
  ] as const) {
    fetch.mockResolvedValueOnce(json(status, { error }));
    await expect(client.sync()).rejects.toThrow(error);
  }
});

test("no session: rejects without calling fetch", async () => {
  const fetch = vi.fn();
  const client = createFetchSyncClient({ fetch, getAccessToken: async () => null });
  await expect(client.sync()).rejects.toThrow(/sign in again/);
  expect(fetch).not.toHaveBeenCalled();
});

test("recompute repeats with offset=nextOffset until done, summing activities and keeping the final days", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(200, { kind: "recompute", activities: 500, days: 0, done: false, nextOffset: 500 }))
    .mockResolvedValueOnce(json(200, { kind: "recompute", activities: 412, days: 1204, done: true, nextOffset: null }));
  const client = createFetchSyncClient({ fetch, getAccessToken: async () => "tok" });
  await expect(client.recompute()).resolves.toEqual({ activities: 912, days: 1204 });
  expect(fetch.mock.calls.map((c) => c[0])).toEqual(["/api/sync?recompute=all", "/api/sync?recompute=all&offset=500"]);
});

test("the mock client answers fixture counts after 300 ms", async () => {
  vi.useFakeTimers();
  const db = createRideFixtureDb(NOW);
  const client = createMockSyncClient(db);
  const p = client.sync();
  await vi.advanceTimersByTimeAsync(300);
  const results = await p;
  expect(results.map((r) => r.source)).toEqual(["garmin_activities", "garmin_weight", "peloton"]);
  expect(results[2].error).toMatch(/invalid_grant/);
  const q = client.recompute();
  await vi.advanceTimersByTimeAsync(300);
  const r = await q;
  expect(r.activities).toBe((await db.listExternalActivities({})).length);
  expect(r.days).toBeGreaterThan(0);
});

test("defaultSyncClient: Starkeep has none, mock and Supabase have one", () => {
  const db = createRideFixtureDb(NOW);
  vi.stubEnv("VITE_DATA_BACKEND", "starkeep");
  expect(defaultSyncClient(db)).toBeNull();
  vi.stubEnv("VITE_DATA_BACKEND", "mock");
  expect(defaultSyncClient(db)).not.toBeNull();
  vi.stubEnv("VITE_DATA_BACKEND", "supabase");
  expect(defaultSyncClient(db)).not.toBeNull();
});
