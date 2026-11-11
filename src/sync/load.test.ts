import { describe, expect, it } from "vitest";
import { activity, constant, context } from "./__fixtures__/rides.js";
import { ingestActivity } from "./ingest.js";
import { loadItems, recomputeDailyLoad } from "./load.js";
import { persistActivity } from "./persist.js";
import { recomputeAll } from "./recompute.js";
import { createMemorySyncStore } from "./testing/memoryStore.js";

const DECAY = Math.exp(-1 / 42);

describe("loadItems", () => {
  it("maps strength sessions to fixed TSS at UTC noon and skips activities without TSS", async () => {
    const store = createMemorySyncStore("owner");
    const a = await persistActivity(store, ingestActivity(activity({ timezone: null }), null, context()));
    const items = loadItems(
      [a, { ...a, id: "no-tss", tss: null }],
      [{ id: "s1", performedOn: "2026-06-02" }],
      { strengthSessionTss: 40 },
      "America/New_York",
    );
    expect(items).toEqual([
      { id: a.id, startedAt: a.startedAt, timezone: "America/New_York", source: "garmin", tss: 55, tssSource: "estimated_flat", pairedActivityId: null },
      { id: "s1", startedAt: "2026-06-02T12:00:00.000Z", timezone: "UTC", source: "strength", tss: 40, tssSource: "strength_fixed" },
    ]);
  });
});

describe("recomputeDailyLoad", () => {
  it("(f) one strength session: strength 50, ctl 50 × (1 − e^(−1/42))", async () => {
    const store = createMemorySyncStore("owner", { strengthSessions: [{ id: "s1", performedOn: "2026-06-01" }] });
    const n = await recomputeDailyLoad(store, "2026-06-01", "2026-06-01", { defaultTimeZone: "UTC" });
    expect(n).toBe(1);
    const row = await store.getDailyLoad("2026-06-01");
    expect(row?.tssBySource.strength).toBe(50);
    expect(row?.ctl).toBeCloseTo(50 * (1 - DECAY), 12);
  });

  it("moves `from` back to the earliest item when the seed row is missing", async () => {
    const store = createMemorySyncStore("owner", { strengthSessions: [{ id: "s1", performedOn: "2026-05-30" }] });
    const n = await recomputeDailyLoad(store, "2026-06-01", "2026-06-01", { defaultTimeZone: "UTC" });
    expect(n).toBe(3);
    expect((await store.getDailyLoad("2026-05-30"))?.tssTotal).toBe(50);
    expect((await store.getDailyLoad("2026-06-01"))?.ctl).toBeCloseTo(50 * (1 - DECAY) * DECAY * DECAY, 12);
  });

  it("seeds from the stored row of the day before", async () => {
    const store = createMemorySyncStore("owner", {
      dailyLoad: [{ date: "2026-05-31", tssTotal: 0, tssBySource: {}, ctl: 42, atl: 7, tsb: 35 }],
      strengthSessions: [{ id: "old", performedOn: "2026-01-01" }],
    });
    const n = await recomputeDailyLoad(store, "2026-06-01", "2026-06-02", { defaultTimeZone: "UTC" });
    expect(n).toBe(2);
    expect((await store.getDailyLoad("2026-06-02"))?.ctl).toBeCloseTo(42 * DECAY * DECAY, 12);
  });

  it("counts a Garmin + Peloton pair once and uses the activity's own time zone", async () => {
    const store = createMemorySyncStore("owner");
    // 02:00Z on 2 June is still 1 June in New York.
    const g = activity({ source: "garmin", sourceId: "g", startedAt: "2026-06-02T02:00:00.000Z", timezone: "America/New_York" });
    const p = activity({ source: "peloton", sourceId: "p", startedAt: "2026-06-02T02:05:00.000Z", timezone: "America/New_York" });
    await persistActivity(store, ingestActivity(g, null, context()));
    await persistActivity(store, ingestActivity(p, null, context()));
    await recomputeDailyLoad(store, "2026-06-01", "2026-06-02", { defaultTimeZone: "UTC" });
    expect((await store.getDailyLoad("2026-06-01"))?.tssBySource).toEqual({ garmin: 55 });
    expect((await store.getDailyLoad("2026-06-02"))?.tssTotal).toBe(0);
  });
});

describe("recomputeAll", () => {
  it("(g) rewrites TSS after a manual FTP change and rebuilds the load to today", async () => {
    const store = createMemorySyncStore("owner", { settings: { manualFtpW: 250 } });
    const r = await persistActivity(store, ingestActivity(activity(), { power: constant(3600, 200) }, context({ manualFtpW: 250 })));
    expect(r.tss).toBeCloseTo(64, 9);

    store.state.settings.manualFtpW = 200;
    const result = await recomputeAll(store, { defaultTimeZone: "UTC", today: "2026-06-03" });
    expect(result).toEqual({ activities: 1, days: 3 });
    const [after] = await store.listAllActivities();
    expect(after.tss).toBeCloseTo(100, 9);
    expect(after.intensityFactor).toBeCloseTo(1, 9);
    expect(after).toMatchObject({ ftpUsedW: 200, ftpSource: "manual", tssSource: "power" });
    expect(store.state.payloads.get(after.id)).toEqual({ synthetic: true });
    expect((await store.getDailyLoad("2026-06-01"))?.tssTotal).toBeCloseTo(100, 9);
  });

  it("builds eFTP from earlier rides only", async () => {
    const store = createMemorySyncStore("owner");
    const first = activity({ sourceId: "r1", startedAt: "2026-06-01T10:00:00.000Z" });
    const second = activity({ sourceId: "r2", startedAt: "2026-06-05T10:00:00.000Z" });
    await persistActivity(store, ingestActivity(first, { power: constant(3600, 200) }, context()));
    await persistActivity(store, ingestActivity(second, { power: constant(3600, 200) }, context()));
    await recomputeAll(store, { defaultTimeZone: "UTC", today: "2026-06-05" });
    const [a, b] = await store.listAllActivities();
    expect(a).toMatchObject({ tssSource: "estimated_flat", ftpUsedW: null, ftpSource: null });
    expect(b).toMatchObject({ tssSource: "power", ftpUsedW: 190, ftpSource: "estimated" });
  });
});

describe("recomputeAll seeding", () => {
  it("ignores a stale stored row before the earliest item", async () => {
    const store = createMemorySyncStore("owner", {
      strengthSessions: [{ id: "s1", performedOn: "2026-06-01" }],
      dailyLoad: [{ date: "2026-05-31", tssTotal: 80, tssBySource: { garmin: 80 }, ctl: 30, atl: 60, tsb: -30 }],
    });
    const result = await recomputeAll(store, { defaultTimeZone: "UTC", today: "2026-06-01" });
    expect(result).toEqual({ activities: 0, days: 1 });
    expect((await store.getDailyLoad("2026-06-01"))?.ctl).toBeCloseTo(50 * (1 - DECAY), 12);
  });
});
