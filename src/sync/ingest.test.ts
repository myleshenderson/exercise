import { describe, expect, it } from "vitest";
import { activity, constant, context, ramp } from "./__fixtures__/rides.js";
import { resolveFtp } from "./ftp.js";
import { ingestActivity, type BestEffort } from "./ingest.js";

describe("ingestActivity", () => {
  it("(a) 3600 s at 200 W with FTP 250: NP 200, IF 0.8, TSS 64 from power", () => {
    const { row, streams } = ingestActivity(activity(), { power: constant(3600, 200) }, context({ manualFtpW: 250 }));
    expect(row.normalizedPowerW).toBeCloseTo(200, 9);
    expect(row.intensityFactor).toBeCloseTo(0.8, 9);
    expect(row.tss).toBeCloseTo(64, 9);
    expect(row.tssSource).toBe("power");
    expect(row.ftpUsedW).toBe(250);
    expect(row.ftpSource).toBe("manual");
    expect(row.hasPower).toBe(true);
    expect(row.avgPowerW).toBe(200);
    expect(row.maxPowerW).toBe(200);
    expect(row.workKj).toBeCloseTo(720, 9);
    expect(row.sport).toBe("cycling");
    expect(row.providerPayload).toEqual({ synthetic: true });
    const curve = row.powerCurve as Record<string, number>;
    expect(curve["1"]).toBe(200);
    expect(curve["1200"]).toBe(200);
    expect(curve["3600"]).toBe(200);
    expect(curve["5400"]).toBeUndefined();
    expect(streams).toEqual([{ channel: "power", startOffsetS: 0, values: constant(3600, 200) }]);
  });

  it("(b) 7200 s moving, no power, defaults: TSS 110 estimated_flat, no FTP", () => {
    const { row, streams } = ingestActivity(activity({ elapsedS: 7400, movingS: 7200 }), null, context());
    expect(row.tss).toBeCloseTo(110, 9);
    expect(row.tssSource).toBe("estimated_flat");
    expect(row.ftpUsedW).toBeNull();
    expect(row.ftpSource).toBeNull();
    expect(row.normalizedPowerW).toBeNull();
    expect(row.intensityFactor).toBeNull();
    expect(row.hasPower).toBe(false);
    expect(row.powerCurve).toBeNull();
    expect(streams).toEqual([]);
  });

  it("does not set NP or IF when power exists but no FTP is known", () => {
    const { row } = ingestActivity(activity(), { power: constant(3600, 200) }, context());
    expect(row.tssSource).toBe("estimated_flat");
    expect(row.normalizedPowerW).toBeNull();
    expect(row.intensityFactor).toBeNull();
    expect(row.powerCurve).not.toBeNull();
  });

  it("(c) 10 m/s outdoors: 10K in 1000 s, 30K in 3000 s, no 40K; indoors no best efforts", () => {
    const distance = ramp(3600, (i) => 10 * i);
    const outdoor = ingestActivity(activity(), { distance }, context()).row;
    const efforts = outdoor.bestEfforts as BestEffort[];
    const by = (label: string) => efforts.find((e) => e.label === label);
    expect(by("10K")).toEqual({ label: "10K", distanceM: 10000, seconds: 1000 });
    expect(by("30K")?.seconds).toBeCloseTo(3000, 9);
    expect(by("40K")).toBeUndefined();

    const indoor = ingestActivity(activity({ environment: "indoor" }), { distance }, context()).row;
    expect(indoor.bestEfforts).toBeNull();
    expect(ingestActivity(activity(), null, context()).row.bestEfforts).toBeNull();
  });

  it("(d) altitude 0 to 100 m over 1000 s then flat: biggest climb about 100 m, null indoors", () => {
    const altitude = ramp(2000, (i) => (i < 1000 ? i / 10 : 100));
    const { row } = ingestActivity(activity(), { altitude }, context());
    expect(Math.abs((row.biggestClimbM as number) - 100)).toBeLessThanOrEqual(2);
    expect(Math.abs((row.elevationGainM as number) - 100)).toBeLessThanOrEqual(2);
    const indoor = ingestActivity(activity({ environment: "indoor" }), { altitude }, context()).row;
    expect(indoor.biggestClimbM).toBeNull();
    // The provider's own gain wins.
    expect(ingestActivity(activity({ elevationGainM: 120 }), { altitude }, context()).row.elevationGainM).toBe(120);
  });

  it("takes HR and cadence from streams (ignoring zeros), else from the provider", () => {
    const hr = [null, 0, 100, 140];
    const cadence = [0, 80, 90, null];
    const fromStreams = ingestActivity(activity({ avgHrBpm: 1, maxHrBpm: 2 }), { heart_rate: hr, cadence }, context()).row;
    expect(fromStreams.avgHrBpm).toBe(120);
    expect(fromStreams.maxHrBpm).toBe(140);
    expect(fromStreams.avgCadenceRpm).toBe(85);
    expect(fromStreams.hasHr).toBe(true);

    const fromProvider = ingestActivity(activity({ avgHrBpm: 130, maxHrBpm: 170, avgCadenceRpm: 88 }), null, context()).row;
    expect(fromProvider.avgHrBpm).toBe(130);
    expect(fromProvider.maxHrBpm).toBe(170);
    expect(fromProvider.avgCadenceRpm).toBe(88);
    expect(fromProvider.hasHr).toBe(true);
    expect(ingestActivity(activity(), null, context()).row.hasHr).toBe(false);
  });

  it("stores every channel, lat/lng included, unchanged", () => {
    const channels = { lat: [45, 45.1], lng: [7, 7.1], speed: [5, null] };
    const { streams } = ingestActivity(activity(), channels, context());
    expect(streams).toEqual([
      { channel: "lat", startOffsetS: 0, values: [45, 45.1] },
      { channel: "lng", startOffsetS: 0, values: [7, 7.1] },
      { channel: "speed", startOffsetS: 0, values: [5, null] },
    ]);
  });

  it("puts streamStartOffsetS on every stream without changing startedAt or the arrays", () => {
    const channels = { power: [200, 210], heart_rate: [120, null] };
    const { row, streams } = ingestActivity(activity(), channels, context(), 7);
    expect(row.startedAt).toBe(activity().startedAt);
    expect(streams).toEqual([
      { channel: "power", startOffsetS: 7, values: [200, 210] },
      { channel: "heart_rate", startOffsetS: 7, values: [120, null] },
    ]);
  });
});

describe("resolveFtp", () => {
  const history = [
    { id: "h1", effectiveFrom: "2026-01-01T00:00:00Z", ftpW: 240.4, source: "peloton_test" as const, sourceRef: null },
    { id: "h2", effectiveFrom: "2026-05-01T00:00:00Z", ftpW: 251.6, source: "peloton_manual" as const, sourceRef: null },
  ];

  it("prefers manual FTP", () => {
    expect(resolveFtp("2026-06-01T10:00:00Z", context({ manualFtpW: 260 }, { ftpHistory: history }))).toEqual({
      ftpW: 260,
      source: "manual",
    });
  });

  it("uses the latest history entry in force, rounded, with its source", () => {
    expect(resolveFtp("2026-06-01T10:00:00Z", context({}, { ftpHistory: history }))).toEqual({ ftpW: 252, source: "peloton_manual" });
    expect(resolveFtp("2026-03-01T10:00:00Z", context({}, { ftpHistory: history }))).toEqual({ ftpW: 240, source: "peloton_test" });
  });

  it("falls back to eFTP from prior rides, then to null", () => {
    const priorRides = [{ startedAt: "2026-05-20T10:00:00Z", mmp20minW: 300 }];
    expect(resolveFtp("2026-06-01T10:00:00Z", context({}, { priorRides }))).toEqual({ ftpW: 285, source: "estimated" });
    expect(resolveFtp("2025-06-01T10:00:00Z", context({}, { priorRides }))).toEqual({ ftpW: null, source: null });
  });
});
