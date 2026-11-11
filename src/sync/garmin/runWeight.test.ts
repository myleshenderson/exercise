import { describe, expect, it } from "vitest";
import { context } from "../__fixtures__/rides.js";
import { createMemorySyncStore } from "../testing/memoryStore.js";
import type { SyncState } from "../../types.js";
import { createGarminClient } from "./client.js";
import { runGarminWeight } from "./runWeight.js";
import { fakeGarmin, type FakeGarminOptions } from "./__fixtures__/fakeGarmin.js";
import { EMPTY_WEIGHT_RANGE, JWT_IAT, WEIGHT_RANGE } from "./__fixtures__/garmin.js";

const NOW = JWT_IAT * 1000 + 3_600_000; // 2026-01-01T01:00Z

const baseState: SyncState = {
  source: "garmin_weight",
  cursor: null,
  lastRunAt: null,
  lastSuccessAt: null,
  itemsFetched: 0,
  itemsUpserted: 0,
  lastError: null,
  backfillComplete: false,
  authStatus: "ok",
};

function setup(o: FakeGarminOptions = {}, syncState: SyncState[] = []) {
  const fake = fakeGarmin(o);
  const clock = { t: NOW };
  const now = () => clock.t;
  const client = createGarminClient({ fetch: fake.fetch, apiKey: "k", sleep: async () => {}, now });
  const store = createMemorySyncStore("user-1", { syncState });
  const opts = { mode: "full" as const, deadlineMs: NOW + 60_000, now, ingestContext: async () => context() };
  const ranges = () => fake.dataCalls().map((c) => c.url.pathname.split("/").slice(-2).join(".."));
  return { fake, clock, client, store, opts, ranges };
}

describe("runGarminWeight", () => {
  it("(h) walks years down and stops after three empty years in a row", async () => {
    const s = setup({ weight: (start) => (start === "2025-01-01" ? WEIGHT_RANGE : EMPTY_WEIGHT_RANGE) });
    const r = await runGarminWeight(s.client, s.store, s.opts);
    expect(r).toMatchObject({ source: "garmin_weight", fetched: 2, upserted: 2, done: true, error: null, earliestAffected: null });
    expect(s.ranges()).toEqual([
      "2026-01-01..2026-12-31",
      "2025-01-01..2025-12-31",
      "2024-01-01..2024-12-31",
      "2023-01-01..2023-12-31",
      "2022-01-01..2022-12-31",
    ]);
    expect(s.store.state.syncState.get("garmin_weight")).toMatchObject({
      backfillComplete: true,
      cursor: { mode: "incremental" },
      authStatus: "ok",
      itemsUpserted: 2,
      lastSuccessAt: new Date(NOW).toISOString(),
    });
  });

  it("(g) stores kg and the timestampGMT instant", async () => {
    const s = setup({ weight: (start) => (start === "2026-01-01" ? WEIGHT_RANGE : EMPTY_WEIGHT_RANGE) });
    await runGarminWeight(s.client, s.store, s.opts);
    const w = s.store.state.bodyWeights.find((x) => x.sourceId === "700000002")!;
    expect(w.weightKg).toBe(80);
    expect(w.measuredAt).toBe("2026-06-02T07:30:00.000Z");
  });

  it("stops at year 2000", async () => {
    const s = setup({ weight: () => WEIGHT_RANGE });
    s.opts.deadlineMs = NOW + 3_600_000;
    const r = await runGarminWeight(s.client, s.store, s.opts);
    expect(r.done).toBe(true);
    expect(s.ranges()[26]).toBe("2000-01-01..2000-12-31");
    expect(s.ranges()).toHaveLength(27);
  });

  it("saves the year cursor at the deadline and resumes from it", async () => {
    const s = setup({
      weight: (start) => {
        s.clock.t = NOW + 60_000;
        return start === "2026-01-01" ? WEIGHT_RANGE : EMPTY_WEIGHT_RANGE;
      },
    });
    const first = await runGarminWeight(s.client, s.store, s.opts);
    expect(first).toMatchObject({ done: false, error: null, upserted: 2 });
    expect(s.store.state.syncState.get("garmin_weight")!.cursor).toEqual({ mode: "backfill", year: 2025, emptyYears: 0 });

    s.opts.deadlineMs = NOW + 3_600_000;
    await runGarminWeight(s.client, s.store, s.opts);
    expect(s.ranges().slice(1)).toEqual(["2025-01-01..2025-12-31", "2024-01-01..2024-12-31", "2023-01-01..2023-12-31"]);
    // Held at the first backfill run, the only one that read the current year.
    expect(s.store.state.syncState.get("garmin_weight")).toMatchObject({
      backfillComplete: true,
      lastSuccessAt: new Date(NOW).toISOString(),
    });
  });

  it("incremental reads last_success_at − 3 days to today", async () => {
    const s = setup({ weight: () => WEIGHT_RANGE }, [
      { ...baseState, backfillComplete: true, cursor: { mode: "incremental" }, lastSuccessAt: "2025-12-31T23:00:00.000Z" },
    ]);
    const r = await runGarminWeight(s.client, s.store, { ...s.opts, mode: "incremental" });
    expect(r).toMatchObject({ fetched: 2, upserted: 2, done: true });
    expect(s.ranges()).toEqual(["2025-12-28..2026-01-01"]);
    expect(s.store.state.bodyWeights).toHaveLength(2);
  });

  it("sets reconnect_required on a refused key", async () => {
    const s = setup({ tokens: [() => new Response("", { status: 401 })] });
    const r = await runGarminWeight(s.client, s.store, s.opts);
    expect(r.error).toBe("GARMIN_API_KEY rejected (HTTP 401)");
    expect(s.fake.calls).toHaveLength(1);
    expect(s.store.state.syncState.get("garmin_weight")).toMatchObject({
      authStatus: "reconnect_required",
      cursor: { mode: "backfill", year: 2026, emptyYears: 0 },
    });
  });
});
