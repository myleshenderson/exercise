import { weightTrend, wPerKg } from "./weight";

describe("weightTrend", () => {
  it("80, 81, 79 kg in the week averages 80", () => {
    const weighIns = [
      { measuredAt: "2026-11-05", weightKg: 80 },
      { measuredAt: "2026-11-08T12:00:00Z", timezone: "America/New_York", weightKg: 81 },
      { measuredAt: "2026-11-11T07:00:00Z", weightKg: 79 },
    ];
    expect(weightTrend(weighIns, "2026-11-11")).toEqual({ avg7Kg: 80, change4wKg: null });
  });
  it("uses the local day and the 7 days ending at date", () => {
    const weighIns = [
      // 2026-11-12 03:00Z is still 2026-11-11 in New York.
      { measuredAt: "2026-11-12T03:00:00Z", timezone: "America/New_York", weightKg: 82 },
      { measuredAt: "2026-11-04", weightKg: 90 }, // 8th day back: outside
    ];
    expect(weightTrend(weighIns, "2026-11-11").avg7Kg).toBe(82);
  });
  it("4-week change is avg7(date) − avg7(date − 28)", () => {
    const weighIns = [
      { measuredAt: "2026-11-11", weightKg: 80 },
      { measuredAt: "2026-10-14", weightKg: 82 },
      { measuredAt: "2026-10-08", weightKg: 84 },
      { measuredAt: "2026-10-07", weightKg: 100 }, // outside the earlier window
    ];
    const t = weightTrend(weighIns, "2026-11-11");
    expect(t.avg7Kg).toBe(80);
    expect(t.change4wKg).toBe(-3);
  });
  it("is null for empty, all-null, unparseable input or a bad date", () => {
    expect(weightTrend([], "2026-11-11")).toEqual({ avg7Kg: null, change4wKg: null });
    expect(weightTrend([{ measuredAt: "2026-11-11", weightKg: null }], "2026-11-11")).toEqual({ avg7Kg: null, change4wKg: null });
    expect(weightTrend([{ measuredAt: "junk", weightKg: 80 }], "2026-11-11").avg7Kg).toBeNull();
    expect(weightTrend([{ measuredAt: "2026-11-11", weightKg: 80 }], "junk")).toEqual({ avg7Kg: null, change4wKg: null });
  });
});

describe("wPerKg", () => {
  it("FTP 250 at 80 kg is 3.125 W/kg", () => {
    expect(wPerKg(250, 80)).toBe(3.125);
  });
  it("is null for missing or non-positive inputs", () => {
    expect(wPerKg(null, 80)).toBeNull();
    expect(wPerKg(250, null)).toBeNull();
    expect(wPerKg(250, 0)).toBeNull();
    expect(wPerKg(Number.NaN, 80)).toBeNull();
  });
});
