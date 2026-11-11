import { describe, expect, it } from "vitest";
import type { SyncState } from "../../types.js";
import { context } from "../__fixtures__/rides.js";
import { createMemorySyncStore, type MemorySyncStore } from "../testing/memoryStore.js";
import type { IngestContext } from "../types.js";
import {
  CLASS_ID,
  CLASS_RIDE_ID,
  FREESTYLE_ID,
  STRETCH_ID,
  SYNTHETIC_FTP,
  USER_ID,
  classDetail,
  classWorkout,
  freestyleDetail,
  freestyleWorkout,
  fakeFetch,
  jsonResponse,
  graph120,
  listPage0,
  listPage1,
  pelotonApi,
} from "./__fixtures__/peloton.js";
import { createPelotonClient } from "./client.js";
import { PelotonReconnectRequired } from "./errors.js";
import { readPelotonCursor, runPeloton } from "./run.js";
import type { PelotonCursor } from "./types.js";

/** The freestyle ride's start_time (epoch s), 2026-01-01T15:30:00Z. */
const FREESTYLE_START_ISO_SECONDS = 1767281400;
const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const noSleep = async () => {};

function setup(override?: (path: string) => Response | undefined, getToken: () => Promise<string> = async () => "token") {
  const { fetch, calls } = fakeFetch(pelotonApi(override));
  const client = createPelotonClient({ fetch, getToken, sleep: noSleep });
  const paths = () => calls.map((c) => new URL(c.url).pathname);
  return { client, calls, paths };
}

const opts = (ctx: IngestContext = context(), over: Partial<Parameters<typeof runPeloton>[2]> = {}) => ({
  mode: "full" as const,
  deadlineMs: NOW + 3_600_000,
  now: () => NOW,
  ingestContext: ctx,
  ...over,
});

const pelotonRows = (store: MemorySyncStore) => [...store.state.activities.values()].filter((a) => a.source === "peloton");
const rowOf = (store: MemorySyncStore, id: string) => pelotonRows(store).find((a) => a.sourceId === id);
const cursorOf = async (store: MemorySyncStore) => (await store.getSyncState("peloton"))?.cursor as PelotonCursor;

describe("runPeloton", () => {
  it("(i) backfill skips stretching, ingests both rides and completes at page_count", async () => {
    const store = createMemorySyncStore("owner");
    const { client, paths } = setup();
    const result = await runPeloton(client, store, opts());

    expect(result).toMatchObject({ source: "peloton", upserted: 2, done: true, error: null });
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.earliestAffected).toBe("2026-01-01T15:30:00.000Z");
    expect(paths().filter((p) => p.includes(STRETCH_ID))).toEqual([]);
    expect(paths()).toContain(`/api/workout/${CLASS_ID}/performance_graph`);
    expect(paths()).toContain(`/api/workout/${FREESTYLE_ID}/performance_graph`);
    expect(paths()).not.toContain(`/api/user/${USER_ID}/workout_history_csv`);
    // Ride details only for the FTP-titled class.
    expect(paths().filter((p) => p.startsWith("/api/ride/"))).toEqual([`/api/ride/${CLASS_RIDE_ID}/details`]);
    expect(paths().filter((p) => p.endsWith("/workouts"))).toHaveLength(3); // pages 0 and 1, then the incremental check of page 0

    const state = await store.getSyncState("peloton");
    expect(state).toMatchObject({ backfillComplete: true, authStatus: "ok", lastError: null, itemsUpserted: 2 });
    expect(state?.lastSuccessAt).toBe("2026-11-11T12:00:00.000Z");
    expect(state?.cursor).toEqual({ mode: "incremental", retry: [] });

    const cls = rowOf(store, CLASS_ID)!;
    expect(cls.hasPower).toBe(true);
    expect(cls.tssSource).toBe("power");
    expect(cls.timezone).toBe("Etc/GMT+5");
    expect(store.state.streams.get(cls.id)?.map((s) => s.channel).sort()).toEqual(["cadence", "heart_rate", "power", "resistance", "speed"]);
    expect(store.state.payloads.get(cls.id)).toMatchObject({ isFtpTest: true, csv: null, workout: { id: CLASS_ID, ftp_info: { ftp: SYNTHETIC_FTP } } });
    expect(store.state.payloads.get(rowOf(store, FREESTYLE_ID)!.id)).toMatchObject({ isFtpTest: null });
  });

  it("(i) incremental pages from 0 and stops at the first stored cycling workout", async () => {
    const store = createMemorySyncStore("owner");
    await runPeloton(setup().client, store, opts());

    const NEW_ID = "w0000000000000000000000000000004";
    const newer = { ...classWorkout, id: NEW_ID, start_time: classWorkout.start_time + 7200, end_time: classWorkout.start_time + 7320 };
    const { client, paths } = setup((path) => {
      if (path === `/api/user/${USER_ID}/workouts?joins=ride,ride.instructor&limit=20&page=0&sort_by=-created`)
        return jsonResponse({ ...listPage0, data: [newer, ...listPage0.data] });
      if (path === `/api/workout/${NEW_ID}`) return jsonResponse({ ...newer, ftp_info: null });
      if (path === `/api/workout/${NEW_ID}/performance_graph`) return setupGraph();
      return undefined;
    });
    const result = await runPeloton(client, store, opts(context(), { mode: "incremental" }));

    expect(result).toMatchObject({ upserted: 1, done: true, error: null });
    expect(rowOf(store, NEW_ID)).toBeDefined();
    expect(paths().filter((p) => p.endsWith("/workouts"))).toHaveLength(1); // page 1 never fetched
    expect(paths().filter((p) => p.startsWith("/api/workout/"))).toEqual([`/api/workout/${NEW_ID}`, `/api/workout/${NEW_ID}/performance_graph`]);
  });

  it("(h) a graph 500 uses the CSV row, stores no streams, adds the id to retry; the next run refetches it", async () => {
    const store = createMemorySyncStore("owner");
    let graphDown = true;
    const { client, paths } = setup((path) =>
      graphDown && path.endsWith("/performance_graph") ? new Response("boom", { status: 500 }) : undefined,
    );
    const result = await runPeloton(client, store, opts());

    expect(result).toMatchObject({ upserted: 2, done: true, error: null });
    // CSV fetched once, lazily, for two failing rides; each graph tried 4 times (3 retries).
    expect(paths().filter((p) => p.endsWith("/workout_history_csv"))).toHaveLength(1);
    expect(paths().filter((p) => p === `/api/workout/${CLASS_ID}/performance_graph`)).toHaveLength(4);
    expect(await cursorOf(store)).toEqual({ mode: "incremental", retry: [CLASS_ID, FREESTYLE_ID] });

    const cls = rowOf(store, CLASS_ID)!;
    expect(store.state.streams.get(cls.id)).toEqual([]);
    expect(cls.hasPower).toBe(false);
    expect(cls.tssSource).toBe("estimated_flat");
    expect(cls.avgPowerW).toBe(104); // the 30 kJ row, not the 45 kJ duplicate
    expect(cls.distanceM).toBeCloseTo(0.5 * 1609.344, 9);
    expect(store.state.payloads.get(cls.id)).toMatchObject({ csv: { "Total Output": "30" }, workout: { ftp_info: { ftp: SYNTHETIC_FTP } } });

    graphDown = false;
    const before = paths().length;
    const again = await runPeloton(client, store, opts(context(), { mode: "incremental" }));
    expect(again).toMatchObject({ upserted: 2, error: null, done: true });
    // Retry ids are refetched first.
    expect(paths().slice(before + 1, before + 3)).toEqual([`/api/workout/${CLASS_ID}`, `/api/workout/${CLASS_ID}/performance_graph`]);
    expect(rowOf(store, CLASS_ID)!.hasPower).toBe(true);
    expect(store.state.streams.get(cls.id)?.length).toBe(5);
    expect(await cursorOf(store)).toEqual({ mode: "incremental", retry: [] });
  });

  it("(j) records a new FTP before ingest so the ride's own TSS uses it", async () => {
    const store = createMemorySyncStore("owner");
    const ctx = context();
    await runPeloton(setup().client, store, opts(ctx));
    // Class: test-sourced, its test workout unknown → effective from the class start. Freestyle
    // (older) is manual with no entry in force at its start → its own entry.
    expect(store.state.ftpHistory.map((h) => [h.source, h.effectiveFrom, h.ftpW, h.sourceRef])).toEqual([
      ["peloton_test", "2026-01-02T12:01:00.000Z", SYNTHETIC_FTP, "w0000000000000000000000000000009"],
      ["peloton_manual", "2026-01-01T15:30:00.000Z", SYNTHETIC_FTP, null],
    ]);
    expect(ctx.ftpHistory).toHaveLength(2);
    const cls = rowOf(store, CLASS_ID)!;
    expect(cls.ftpUsedW).toBe(SYNTHETIC_FTP);
    expect(cls.ftpSource).toBe("peloton_test");
  });

  it("(j) skips the FTP entry when the one in force has the same watts", async () => {
    const existing = { id: "ftp-x", effectiveFrom: "2025-06-01T00:00:00.000Z", ftpW: SYNTHETIC_FTP, source: "peloton_test" as const, sourceRef: null };
    const store = createMemorySyncStore("owner", { ftpHistory: [existing] });
    const ctx = context({}, { ftpHistory: [existing] });
    await runPeloton(setup().client, store, opts(ctx));
    expect(store.state.ftpHistory).toEqual([existing]);
    expect(ctx.ftpHistory).toEqual([existing]);
    expect(rowOf(store, CLASS_ID)!.ftpUsedW).toBe(SYNTHETIC_FTP);
  });

  it("dates a test-sourced FTP at its test workout when the test sits on a later page", async () => {
    const TEST_ID = "w0000000000000000000000000000010";
    const TEST_START = FREESTYLE_START_ISO_SECONDS - 86_400; // a day before the freestyle ride
    const testWorkout = { ...freestyleWorkout, id: TEST_ID, start_time: TEST_START, end_time: TEST_START + 1200, ride: { id: "r10", title: null } };
    const store = createMemorySyncStore("owner");
    const { client, paths } = setup((path) => {
      if (path === `/api/workout/${CLASS_ID}`)
        return jsonResponse({ ...classDetail, ftp_info: { ftp: 200, ftp_source: "ftp_workout_source", ftp_workout_id: TEST_ID } });
      if (path === `/api/user/${USER_ID}/workouts?joins=ride,ride.instructor&limit=20&page=1&sort_by=-created`)
        return jsonResponse({ ...listPage1, data: [freestyleWorkout, testWorkout] });
      if (path === `/api/workout/${TEST_ID}`) return jsonResponse({ ...testWorkout, ftp_info: { ftp: 180, ftp_source: "ftp_manual_source", ftp_workout_id: null } });
      if (path === `/api/workout/${TEST_ID}/performance_graph`) return jsonResponse(graph120);
      if (path === `/api/workout/${FREESTYLE_ID}`)
        return jsonResponse({ ...freestyleDetail, ftp_info: { ftp: 200, ftp_source: "ftp_workout_source", ftp_workout_id: TEST_ID } });
      return undefined;
    });
    const result = await runPeloton(client, store, opts());

    expect(result).toMatchObject({ upserted: 3, done: true, error: null });
    const testIso = new Date(TEST_START * 1000).toISOString();
    expect(store.state.ftpHistory.filter((h) => h.source === "peloton_test").map((h) => [h.effectiveFrom, h.ftpW, h.sourceRef])).toEqual([
      [testIso, 200, TEST_ID],
    ]);
    // Fetched once (page 0's class), not again for the freestyle ride, then ingested from page 1.
    expect(paths().filter((p) => p === `/api/workout/${TEST_ID}`)).toHaveLength(2);
    // Backfill pages 0 and 1 (2 + 2 items), the one test fetch, then the incremental page 0 (2 items).
    expect(result.fetched).toBe(2 + 2 + 1 + 2);
    expect(rowOf(store, CLASS_ID)!.ftpUsedW).toBe(200);
  });

  it("collapses repeated manual FTP entries to one when the backfill completes", async () => {
    const day = 86_400;
    const rides = [0, 1, 2].map((i) => ({
      ...freestyleWorkout,
      id: `w00000000000000000000000000001${i}`,
      start_time: FREESTYLE_START_ISO_SECONDS - (i + 1) * day,
      end_time: FREESTYLE_START_ISO_SECONDS - (i + 1) * day + 600,
    }));
    const store = createMemorySyncStore("owner");
    const ctx = context();
    const { client } = setup((path) => {
      if (path === `/api/user/${USER_ID}/workouts?joins=ride,ride.instructor&limit=20&page=0&sort_by=-created`)
        return jsonResponse({ ...listPage0, data: rides, page_count: 1 });
      const ride = rides.find((r) => path === `/api/workout/${r.id}`);
      if (ride) return jsonResponse({ ...ride, ftp_info: { ftp: 150, ftp_source: "ftp_manual_source", ftp_workout_id: null } });
      if (rides.some((r) => path === `/api/workout/${r.id}/performance_graph`)) return jsonResponse(graph120);
      return undefined;
    });
    const result = await runPeloton(client, store, opts(ctx));

    expect(result).toMatchObject({ upserted: 3, done: true, error: null, notes: ["ftp_history collapsed: 2"] });
    const oldest = new Date(rides[2].start_time * 1000).toISOString();
    expect(store.state.ftpHistory.map((h) => [h.source, h.effectiveFrom, h.ftpW])).toEqual([["peloton_manual", oldest, 150]]);
    expect(ctx.ftpHistory.map((h) => h.effectiveFrom)).toEqual([oldest]);
    // Every ride kept its own FTP.
    expect(pelotonRows(store).map((a) => a.ftpUsedW)).toEqual([150, 150, 150]);

    // A later incremental run does not collapse again.
    const again = await runPeloton(client, store, opts(ctx, { mode: "incremental" }));
    expect(again.notes).toBeUndefined();
  });

  it("collapse only drops a Peloton entry that repeats the previous kept entry of any source", async () => {
    const manual = { id: "m1", effectiveFrom: "2026-01-02T00:00:00.000Z", ftpW: 999, source: "manual" as const, sourceRef: null };
    const seeded = [
      { id: "p1", effectiveFrom: "2026-01-01T00:00:00.000Z", ftpW: SYNTHETIC_FTP, source: "peloton_manual" as const, sourceRef: null },
      manual,
      { id: "p2", effectiveFrom: "2026-01-01T15:00:00.000Z", ftpW: SYNTHETIC_FTP, source: "peloton_manual" as const, sourceRef: null },
      { id: "p3", effectiveFrom: "2026-01-03T00:00:00.000Z", ftpW: SYNTHETIC_FTP, source: "peloton_manual" as const, sourceRef: null },
    ];
    const store = createMemorySyncStore("owner", { ftpHistory: seeded });
    const result = await runPeloton(setup().client, store, opts(context({}, { ftpHistory: seeded })));
    expect(result.notes).toEqual(["ftp_history collapsed: 1"]);
    // p2 repeats p1 and goes; p3 follows the class's peloton_test entry (after m1), so it stays.
    expect((await store.listFtpHistory()).map((h) => [h.id.startsWith("ftp-") ? "new" : h.id, h.source])).toEqual([
      ["p1", "peloton_manual"],
      ["m1", "manual"],
      ["new", "peloton_test"],
      ["p3", "peloton_manual"],
    ]);
  });

  it("stops at the deadline with the cursor on the current page and resumes without duplicates", async () => {
    const store = createMemorySyncStore("owner");
    let t = NOW;
    // Allows me + page 0 (stretch, class) and then expires before the page-1 item.
    const clock = () => t;
    const { client } = setup((path) => {
      if (path.endsWith("/performance_graph")) t += 1; // time passes as we work
      return undefined;
    });
    const first = await runPeloton(client, store, opts(context(), { now: clock, deadlineMs: NOW + 1 }));
    expect(first).toMatchObject({ done: false, error: null, upserted: 1 });
    expect(await cursorOf(store)).toEqual({ mode: "backfill", page: 1, retry: [] });
    expect((await store.getSyncState("peloton"))?.backfillComplete).toBe(false);

    const second = await runPeloton(client, store, opts(context(), { now: clock, deadlineMs: t + 3_600_000 }));
    expect(second).toMatchObject({ done: true, error: null, upserted: 1 });
    expect(pelotonRows(store)).toHaveLength(2);
  });

  it("PelotonReconnectRequired ends the run with error set and leaves other sources alone", async () => {
    const garmin: SyncState = {
      source: "garmin_activities",
      cursor: { mode: "incremental" },
      lastRunAt: "2026-11-10T00:00:00.000Z",
      lastSuccessAt: "2026-11-10T00:00:00.000Z",
      itemsFetched: 5,
      itemsUpserted: 5,
      lastError: null,
      backfillComplete: true,
      authStatus: "ok",
    };
    const store = createMemorySyncStore("owner", { syncState: [garmin] });
    const { client, calls } = setup(undefined, async () => {
      throw new PelotonReconnectRequired("Peloton refresh token rejected (HTTP 400 invalid_grant)");
    });
    const result = await runPeloton(client, store, opts());
    expect(result.error).toMatch(/PelotonReconnectRequired/);
    expect(result).toMatchObject({ done: false, upserted: 0 });
    expect(calls).toHaveLength(0);
    const state = await store.getSyncState("peloton");
    expect(state?.lastError).toMatch(/invalid_grant/);
    expect(state?.lastSuccessAt).toBeNull();
    expect(await store.getSyncState("garmin_activities")).toEqual(garmin);
  });

  it("skips a cycling workout without start_time, and a CSV it cannot parse reads as no rows", async () => {
    const store = createMemorySyncStore("owner");
    const broken = { ...classWorkout, id: "w0000000000000000000000000000005", start_time: null as unknown as number };
    const { client } = setup((path) => {
      if (path === `/api/user/${USER_ID}/workouts?joins=ride,ride.instructor&limit=20&page=0&sort_by=-created`)
        return jsonResponse({ ...listPage0, data: [broken, ...listPage0.data] });
      if (path.endsWith("/performance_graph")) return new Response("boom", { status: 500 });
      if (path.endsWith("/workout_history_csv")) return new Response("Renamed Column,Title\nx,y\n");
      return undefined;
    });
    const result = await runPeloton(client, store, opts());
    expect(result).toMatchObject({ error: null, done: true, upserted: 2 });
    expect(rowOf(store, broken.id)).toBeUndefined();
    expect(store.state.payloads.get(rowOf(store, CLASS_ID)!.id)).toMatchObject({ csv: null });
    expect(await cursorOf(store)).toEqual({ mode: "incremental", retry: [CLASS_ID, FREESTYLE_ID] });
  });

  it("reads cursors defensively", () => {
    expect(readPelotonCursor(null, false)).toEqual({ mode: "backfill", page: 0, retry: [] });
    expect(readPelotonCursor({ mode: "backfill", page: 7, retry: ["a"] }, false)).toEqual({ mode: "backfill", page: 7, retry: ["a"] });
    expect(readPelotonCursor({ mode: "backfill", page: 7, retry: ["a"] }, true)).toEqual({ mode: "incremental", retry: ["a"] });
    expect(readPelotonCursor({ mode: "incremental", retry: [1] }, false)).toEqual({ mode: "backfill", page: 0, retry: [] });
  });
});

function setupGraph(): Response {
  return pelotonApi()(`https://api.onepeloton.com/api/workout/${CLASS_ID}/performance_graph?every_n=1`)!;
}
