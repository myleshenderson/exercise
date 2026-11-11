import { strengthSessionTss, tssForActivity } from "./tss";

const fill = (n: number, w: number | null) => Array<number | null>(n).fill(w);
const ride = [...fill(1800, 100), ...fill(1800, 300)];
const settings = { noPowerTssPerHour: 55 };

describe("tssForActivity", () => {
  it("uses power when the ride has power and FTP is known", () => {
    const r = tssForActivity({ power: ride, hasPower: true, movingSeconds: 3500, elapsedSeconds: 3600, ftpW: 250 }, settings);
    expect(r.source).toBe("power");
    expect(r.tss).toBeCloseTo(102.27, 2);
  });
  it("no power, 5400 s moving, rate 55: 82.5 estimated_flat", () => {
    expect(tssForActivity({ hasPower: false, movingSeconds: 5400, elapsedSeconds: 6000, ftpW: 250 }, settings)).toEqual({
      tss: 82.5,
      source: "estimated_flat",
    });
  });
  it("falls back to the flat rate without an FTP", () => {
    expect(tssForActivity({ power: ride, hasPower: true, movingSeconds: 3600, elapsedSeconds: 3600, ftpW: null })).toEqual({
      tss: 55,
      source: "estimated_flat",
    });
  });
  it("falls back to the flat rate for empty, too-short or missing power", () => {
    for (const power of [[], fill(10, 200), undefined]) {
      expect(tssForActivity({ power, hasPower: true, movingSeconds: 1800, elapsedSeconds: 1800, ftpW: 250 }, settings)).toEqual({
        tss: 27.5,
        source: "estimated_flat",
      });
    }
  });
  it("all-null power counts as 0 W", () => {
    expect(tssForActivity({ power: fill(60, null), hasPower: true, movingSeconds: 60, elapsedSeconds: 60, ftpW: 250 }, settings)).toEqual({
      tss: 0,
      source: "power",
    });
  });
  it("treats a bad moving time as 0", () => {
    expect(tssForActivity({ hasPower: false, movingSeconds: Number.NaN, elapsedSeconds: 0, ftpW: null }, settings).tss).toBe(0);
  });
});

describe("strengthSessionTss", () => {
  it("returns the configured value, default 50", () => {
    expect(strengthSessionTss()).toEqual({ tss: 50, source: "strength_fixed" });
    expect(strengthSessionTss({ strengthSessionTss: 40 })).toEqual({ tss: 40, source: "strength_fixed" });
  });
});
