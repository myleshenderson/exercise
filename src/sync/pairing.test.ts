import { describe, expect, it } from "vitest";
import { activity, constant, context } from "./__fixtures__/rides.js";
import { ingestActivity } from "./ingest.js";
import { findPair, PAIR_WINDOW_S, primaryOf } from "./pairing.js";
import { persistActivity } from "./persist.js";
import { createMemorySyncStore } from "./testing/memoryStore.js";
import type { ProviderActivity } from "./types.js";

const garmin = activity({ source: "garmin", sourceId: "g-1", startedAt: "2026-06-01T10:00:00.000Z", environment: "indoor" });
const peloton = (startedAt: string, sourceId = "p-1"): ProviderActivity =>
  activity({ source: "peloton", sourceId, startedAt, environment: "indoor", avgHrBpm: 140, maxHrBpm: 172 });

async function persist(store: ReturnType<typeof createMemorySyncStore>, a: ProviderActivity, power?: number) {
  return persistActivity(store, ingestActivity(a, power ? { power: constant(3600, power) } : null, context({ manualFtpW: 250 })));
}

describe("pairing", () => {
  it("(e) pairs Garmin 10:00:00Z with Peloton 10:10:00Z and the primary takes the partner's HR", async () => {
    expect(PAIR_WINDOW_S).toBe(600);
    const store = createMemorySyncStore("owner");
    const g = await persist(store, garmin);
    const p = await persist(store, peloton("2026-06-01T10:10:00.000Z"));
    expect(p.pairedActivityId).toBe(g.id);
    const [gs, ps] = await store.listAllActivities();
    expect(gs.pairedActivityId).toBe(p.id);
    expect(ps.pairedActivityId).toBe(g.id);
    // Both flat-rate: the earlier start (Garmin) is primary and takes Peloton's HR.
    expect(gs).toMatchObject({ hasHr: true, avgHrBpm: 140, maxHrBpm: 172 });
    // The payload survives the derived-column writes.
    expect(store.state.payloads.get(g.id)).toEqual({ synthetic: true });
  });

  it("(e) does not pair Peloton at 10:10:01Z", async () => {
    const store = createMemorySyncStore("owner");
    await persist(store, garmin);
    const p = await persist(store, peloton("2026-06-01T10:10:01.000Z"));
    expect(p.pairedActivityId).toBeNull();
    const [gs] = await store.listAllActivities();
    expect(gs).toMatchObject({ pairedActivityId: null, hasHr: false, avgHrBpm: null });
  });

  it("makes the power row primary; it keeps its own HR flag when it has HR", async () => {
    const store = createMemorySyncStore("owner");
    const g = await persist(store, garmin);
    const p = await persist(store, peloton("2026-06-01T10:05:00.000Z"), 200);
    const [gs, ps] = await store.listAllActivities();
    expect(primaryOf(gs, ps).id).toBe(p.id);
    // Primary Peloton already has HR: nothing copied to Garmin.
    expect(gs).toMatchObject({ id: g.id, hasHr: false, pairedActivityId: p.id });
  });

  it("re-pairs to a nearer partner and clears the former partner", async () => {
    const store = createMemorySyncStore("owner");
    const g = await persist(store, garmin);
    const p1 = await persist(store, peloton("2026-06-01T10:08:00.000Z", "p-1"));
    expect(p1.pairedActivityId).toBe(g.id);
    const p2 = await persist(store, peloton("2026-06-01T10:01:00.000Z", "p-2"));
    expect(p2.pairedActivityId).toBe(g.id);
    const rows = Object.fromEntries((await store.listAllActivities()).map((r) => [r.sourceId, r]));
    expect(rows["g-1"].pairedActivityId).toBe(p2.id);
    expect(rows["p-1"].pairedActivityId).toBeNull();
  });

  it("re-syncing a row keeps the pair", async () => {
    const store = createMemorySyncStore("owner");
    await persist(store, garmin);
    const p = await persist(store, peloton("2026-06-01T10:10:00.000Z"));
    const g2 = await persist(store, garmin);
    expect(g2).toMatchObject({ pairedActivityId: p.id, hasHr: true, avgHrBpm: 140 });
  });

  it("findPair: nearest of the other source within the window; strava_export never pairs", () => {
    const a = { id: "a", source: "garmin" as const, startedAt: "2026-06-01T10:00:00Z" };
    const cands = [
      { id: "x", source: "peloton" as const, startedAt: "2026-06-01T10:09:00Z" },
      { id: "y", source: "peloton" as const, startedAt: "2026-06-01T09:58:00Z" },
      { id: "z", source: "garmin" as const, startedAt: "2026-06-01T10:00:00Z" },
      { id: "s", source: "strava_export" as const, startedAt: "2026-06-01T10:00:00Z" },
    ];
    expect(findPair(a, cands)?.id).toBe("y");
    expect(findPair({ ...a, source: "strava_export" }, cands)).toBeNull();
  });

  it("primaryOf: power, then earlier start, then smaller id", () => {
    const base = { startedAt: "2026-06-01T10:00:00Z", tssSource: "estimated_flat" as const };
    expect(primaryOf({ ...base, id: "b" }, { ...base, id: "a" }).id).toBe("a");
    expect(primaryOf({ ...base, id: "a" }, { ...base, id: "b", startedAt: "2026-06-01T09:59:00Z" }).id).toBe("b");
    expect(primaryOf({ ...base, id: "a" }, { ...base, id: "b", startedAt: "2026-06-01T10:05:00Z", tssSource: "power" as const }).id).toBe("b");
  });
});
