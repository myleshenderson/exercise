import { describe, expect, it } from "vitest";
import { activity, constant, context } from "./__fixtures__/rides.js";
import { ingestActivity } from "./ingest.js";
import { persistActivity } from "./persist.js";
import { recomputeAll } from "./recompute.js";
import { createMemorySyncStore } from "./testing/memoryStore.js";

/** Two 200 W hours stored at FTP 250 (TSS 64 each), then the manual FTP drops to 200 (TSS 100). */
async function twoRidesAfterFtpChange() {
  const store = createMemorySyncStore("owner", { settings: { manualFtpW: 250 } });
  for (const [sourceId, startedAt] of [
    ["r2", "2026-06-02T10:00:00.000Z"],
    ["r1", "2026-06-01T10:00:00.000Z"],
  ] as const) {
    await persistActivity(store, ingestActivity(activity({ sourceId, startedAt }), { power: constant(3600, 200) }, context({ manualFtpW: 250 })));
  }
  store.state.settings.manualFtpW = 200;
  return store;
}

const tss = async (store: Awaited<ReturnType<typeof twoRidesAfterFtpChange>>) =>
  (await store.listAllActivities()).map((a) => Math.round(a.tss ?? 0));

describe("recomputeAll deadline and offset (AI-653)", () => {
  it("stops at the deadline with the offset to resume at and skips the daily load", async () => {
    const store = await twoRidesAfterFtpChange();
    const ticks = [0, 1_000];
    const now = () => ticks.shift() ?? 1_000;
    const r = await recomputeAll(store, { defaultTimeZone: "UTC", today: "2026-06-03", deadlineMs: 500, now });
    expect(r).toEqual({ activities: 1, days: 0, done: false, nextOffset: 1 });
    expect(await tss(store)).toEqual([100, 64]);
    expect(await store.getDailyLoad("2026-06-01")).toBeNull();
  });

  it("returns at once with nextOffset = offset when the deadline has already passed", async () => {
    const store = await twoRidesAfterFtpChange();
    const r = await recomputeAll(store, { defaultTimeZone: "UTC", today: "2026-06-03", deadlineMs: 0, offset: 1, now: () => 0 });
    expect(r).toEqual({ activities: 0, days: 0, done: false, nextOffset: 1 });
    expect(await tss(store)).toEqual([64, 64]);
  });

  it("resumes at the offset, leaves earlier activities alone and rebuilds the load from the first ride", async () => {
    const store = await twoRidesAfterFtpChange();
    const r = await recomputeAll(store, { defaultTimeZone: "UTC", today: "2026-06-03", deadlineMs: 500, offset: 1, now: () => 0 });
    expect(r).toEqual({ activities: 1, days: 3, done: true, nextOffset: null });
    expect(await tss(store)).toEqual([64, 100]);
    expect((await store.getDailyLoad("2026-06-01"))?.tssTotal).toBeCloseTo(64, 0);
  });

  it("seeds eFTP from the activities before the offset", async () => {
    const store = createMemorySyncStore("owner");
    await persistActivity(store, ingestActivity(activity({ sourceId: "r1", startedAt: "2026-06-01T10:00:00.000Z" }), { power: constant(3600, 200) }, context()));
    await persistActivity(store, ingestActivity(activity({ sourceId: "r2", startedAt: "2026-06-05T10:00:00.000Z" }), { power: constant(3600, 200) }, context()));
    await recomputeAll(store, { defaultTimeZone: "UTC", today: "2026-06-05", offset: 1 });
    const [, b] = await store.listAllActivities();
    expect(b).toMatchObject({ tssSource: "power", ftpUsedW: 190, ftpSource: "estimated" });
  });

  it("orders by startedAt then id whatever order the store lists them in", async () => {
    const store = await twoRidesAfterFtpChange();
    const listed = await store.listAllActivities();
    const r = await recomputeAll(
      { ...store, listAllActivities: async () => [...listed].reverse() },
      { defaultTimeZone: "UTC", today: "2026-06-03", deadlineMs: 500, now: (() => { const t = [0, 1_000]; return () => t.shift() ?? 1_000; })() },
    );
    expect(r.nextOffset).toBe(1);
    expect(await tss(store)).toEqual([100, 64]);
  });

  it("an offset past the end only rebuilds the daily load", async () => {
    const store = await twoRidesAfterFtpChange();
    const r = await recomputeAll(store, { defaultTimeZone: "UTC", today: "2026-06-03", offset: 5 });
    expect(r).toEqual({ activities: 0, days: 3, done: true, nextOffset: null });
    expect(await tss(store)).toEqual([64, 64]);
  });
});
