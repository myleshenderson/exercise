import { dailyLoad, dedupePairs, loadStep, type LoadItem } from "./load";

const item = (over: Partial<LoadItem> & { id: string }): LoadItem => ({
  startedAt: "2026-11-01T12:00:00Z",
  timezone: "UTC",
  source: "garmin",
  tss: 100,
  tssSource: "power",
  ...over,
});

describe("dailyLoad", () => {
  it("TSS 100 then 0 gives the decision-6 values", () => {
    const rows = dailyLoad([item({ id: "a" })], "2026-11-01", "2026-11-02");
    expect(rows).toHaveLength(2);
    expect(rows[0].ctl).toBeCloseTo(2.353, 3);
    expect(rows[0].atl).toBeCloseTo(13.312, 3);
    expect(rows[0].tsb).toBeCloseTo(-10.959, 3);
    expect(rows[1].ctl).toBeCloseTo(2.297, 3);
    expect(rows[1].atl).toBeCloseTo(11.54, 3);
    expect(rows[1].tsb).toBeCloseTo(-9.243, 3);
    expect(rows[1]).toMatchObject({ date: "2026-11-02", tssTotal: 0, tssBySource: {} });
  });

  it("returns zero rows for every day when there are no items", () => {
    const rows = dailyLoad([], "2026-02-27", "2026-03-01");
    expect(rows.map((r) => r.date)).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
    expect(rows.every((r) => r.tssTotal === 0 && r.ctl === 0 && r.atl === 0 && r.tsb === 0)).toBe(true);
  });

  it("returns [] for a reversed or malformed range", () => {
    expect(dailyLoad([], "2026-11-02", "2026-11-01")).toEqual([]);
    expect(dailyLoad([], "2026-02-30", "2026-03-01")).toEqual([]);
    expect(dailyLoad([], "11/01/2026", "2026-11-02")).toEqual([]);
  });

  it("buckets by the local date in the item's time zone, including Etc/GMT+5", () => {
    const items = [
      item({ id: "a", startedAt: "2026-11-02T03:00:00Z", timezone: "Etc/GMT+5", tss: 40 }),
      item({ id: "b", startedAt: "2026-11-02T03:00:00Z", timezone: "America/Los_Angeles", tss: 10, source: "peloton" }),
      item({ id: "c", startedAt: "2026-11-02T03:00:00Z", timezone: "UTC", tss: 5 }),
    ];
    const rows = dailyLoad(items, "2026-11-01", "2026-11-02");
    expect(rows[0].tssTotal).toBe(50);
    expect(rows[0].tssBySource).toEqual({ garmin: 40, peloton: 10 });
    expect(rows[1].tssTotal).toBe(5);
  });

  it("sums strength and rides by source", () => {
    const items = [
      item({ id: "r", tss: 60 }),
      item({ id: "s", source: "strength", tssSource: "strength_fixed", tss: 50, startedAt: "2026-11-01T17:00:00Z", timezone: "America/New_York" }),
    ];
    const [row] = dailyLoad(items, "2026-11-01", "2026-11-01");
    expect(row.tssTotal).toBe(110);
    expect(row.tssBySource).toEqual({ garmin: 60, strength: 50 });
  });

  it("applies a seed and ignores items outside the range or unusable", () => {
    const items = [
      item({ id: "before", startedAt: "2026-10-01T12:00:00Z" }),
      item({ id: "nan", tss: Number.NaN }),
      item({ id: "bad", startedAt: "junk" }),
    ];
    const [row] = dailyLoad(items, "2026-11-01", "2026-11-01", { ctl: 50, atl: 70 });
    expect(row.tssTotal).toBe(0);
    expect(row.ctl).toBeCloseTo(50 * Math.exp(-1 / 42), 9);
    expect(row.atl).toBeCloseTo(70 * Math.exp(-1 / 7), 9);
    expect(row.tsb).toBeCloseTo(row.ctl - row.atl, 9);
  });

  it("falls back to UTC for an unknown time zone instead of throwing", () => {
    const [row] = dailyLoad([item({ id: "a", timezone: "Not/AZone" })], "2026-11-01", "2026-11-01");
    expect(row.tssTotal).toBe(100);
  });

  it("counts a pair once", () => {
    const garmin = item({ id: "g", tssSource: "estimated_flat", tss: 55, startedAt: "2026-11-01T11:59:00Z" });
    const peloton = item({ id: "p", source: "peloton", tss: 70, pairedActivityId: "g" });
    const [row] = dailyLoad([garmin, peloton], "2026-11-01", "2026-11-01");
    expect(row.tssTotal).toBe(70);
    expect(row.tssBySource).toEqual({ peloton: 70 });
  });
});

describe("dedupePairs", () => {
  it("keeps the power one, in either pointing direction", () => {
    const a = item({ id: "a", tssSource: "estimated_flat", startedAt: "2026-11-01T10:00:00Z", pairedActivityId: "b" });
    const b = item({ id: "b", tssSource: "power", startedAt: "2026-11-01T10:05:00Z" });
    expect(dedupePairs([a, b]).map((x) => x.id)).toEqual(["b"]);
    expect(dedupePairs([{ ...a, pairedActivityId: null }, { ...b, pairedActivityId: "a" }]).map((x) => x.id)).toEqual(["b"]);
  });
  it("keeps the earlier start when neither or both have power, then the lower id", () => {
    const a = item({ id: "a", tssSource: "estimated_flat", startedAt: "2026-11-01T10:05:00Z", pairedActivityId: "b" });
    const b = item({ id: "b", tssSource: "estimated_flat", startedAt: "2026-11-01T10:00:00Z", pairedActivityId: "a" });
    expect(dedupePairs([a, b]).map((x) => x.id)).toEqual(["b"]);
    expect(dedupePairs([{ ...a, tssSource: "power" }, { ...b, tssSource: "power" }]).map((x) => x.id)).toEqual(["b"]);
    expect(dedupePairs([{ ...a, startedAt: b.startedAt }, b]).map((x) => x.id)).toEqual(["a"]);
    expect(dedupePairs([{ ...a, startedAt: "junk" }, b]).map((x) => x.id)).toEqual(["b"]);
  });
  it("keeps an item whose partner is absent and ignores self-pairs", () => {
    expect(dedupePairs([item({ id: "a", pairedActivityId: "zzz" })])).toHaveLength(1);
    expect(dedupePairs([item({ id: "a", pairedActivityId: "a" })])).toHaveLength(1);
    expect(dedupePairs([])).toEqual([]);
  });
});

describe("loadStep", () => {
  it("decays toward zero with no training", () => {
    expect(loadStep({ ctl: 0, atl: 0 }, 0)).toEqual({ ctl: 0, atl: 0 });
  });
});
