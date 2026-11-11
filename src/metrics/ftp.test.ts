import { eftp, ftpAt } from "./ftp";

describe("ftpAt", () => {
  const history = [
    { effectiveFrom: "2026-01-01", ftpW: 230 },
    { effectiveFrom: "2026-06-01", ftpW: 250 },
    { effectiveFrom: "2026-03-01", ftpW: 240 },
  ];
  it("manual FTP wins", () => {
    expect(ftpAt("2026-07-01", { manualFtpW: 260, history })).toBe(260);
    expect(ftpAt("2026-07-01", { manualFtpW: 0, history })).toBe(250);
  });
  it("uses the latest history entry on or before the date", () => {
    expect(ftpAt("2026-07-01", { manualFtpW: null, history })).toBe(250);
    expect(ftpAt("2026-06-01", { manualFtpW: null, history })).toBe(250);
    expect(ftpAt("2026-05-31", { manualFtpW: undefined, history })).toBe(240);
    expect(ftpAt(new Date("2026-02-01T00:00:00Z"), { manualFtpW: null, history })).toBe(230);
  });
  it("is null before any entry, with empty history, or for a bad date", () => {
    expect(ftpAt("2025-12-31", { manualFtpW: null, history })).toBeNull();
    expect(ftpAt("2026-07-01", { manualFtpW: null, history: [] })).toBeNull();
    expect(ftpAt("not a date", { manualFtpW: null, history })).toBeNull();
    expect(ftpAt("2026-07-01", { manualFtpW: null, history: [{ effectiveFrom: "junk", ftpW: 1 }] })).toBeNull();
  });
});

describe("eftp", () => {
  const asOf = "2026-11-11T12:00:00Z";
  const daysBefore = (d: number) => new Date(Date.parse(asOf) - d * 86_400_000).toISOString();
  it("bests 250 and 280 inside the window and 300 at day −91 give 266", () => {
    const rides = [
      { startedAt: daysBefore(10), mmp20minW: 250 },
      { startedAt: daysBefore(89), mmp20minW: 280 },
      { startedAt: daysBefore(91), mmp20minW: 300 },
    ];
    expect(eftp(rides, asOf)).toBeCloseTo(266, 9);
    expect(eftp(rides, new Date(asOf))).toBeCloseTo(266, 9);
  });
  it("window is (asOf − 90 days, asOf]", () => {
    expect(eftp([{ startedAt: daysBefore(90), mmp20minW: 300 }], asOf)).toBeNull();
    expect(eftp([{ startedAt: asOf, mmp20minW: 300 }], asOf)).toBeCloseTo(285, 9);
    expect(eftp([{ startedAt: daysBefore(-1), mmp20minW: 300 }], asOf)).toBeNull();
  });
  it("a date-only asOf includes rides on that day", () => {
    expect(eftp([{ startedAt: "2026-11-11T23:00:00Z", mmp20minW: 300 }], "2026-11-11")).toBeCloseTo(285, 9);
    expect(eftp([{ startedAt: "2026-11-12T00:00:00Z", mmp20minW: 300 }], "2026-11-11")).toBeNull();
  });
  it("is null for empty, all-null or unparseable input", () => {
    expect(eftp([], asOf)).toBeNull();
    expect(eftp([{ startedAt: asOf, mmp20minW: null }], asOf)).toBeNull();
    expect(eftp([{ startedAt: "junk", mmp20minW: 300 }], asOf)).toBeNull();
    expect(eftp([{ startedAt: asOf, mmp20minW: 300 }], "junk")).toBeNull();
  });
});
