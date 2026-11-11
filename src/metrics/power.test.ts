import { intensityFactor, meanMaxPower, normalizedPower, STANDARD_DURATIONS_S, tssFromPower, workKj } from "./power";

const fill = (n: number, w: number | null) => Array<number | null>(n).fill(w);
const ride = [...fill(1800, 100), ...fill(1800, 300)];

describe("normalizedPower", () => {
  it("30 × 0 W then 30 × 300 W is 203.09 W", () => {
    expect(normalizedPower([...fill(30, 0), ...fill(30, 300)])).toBeCloseTo(203.09, 2);
  });
  it("1800 × 100 W then 1800 × 300 W is 252.83 W", () => {
    expect(normalizedPower(ride)).toBeCloseTo(252.83, 2);
  });
  it("is null for empty or under 30 samples", () => {
    expect(normalizedPower([])).toBeNull();
    expect(normalizedPower(fill(29, 300))).toBeNull();
  });
  it("counts nulls as 0 W", () => {
    expect(normalizedPower(fill(60, null))).toBe(0);
    expect(normalizedPower([...fill(30, null), ...fill(30, 300)])).toBeCloseTo(203.09, 2);
  });
  it("equals the constant for a steady ride", () => {
    expect(normalizedPower(fill(30, 200))).toBeCloseTo(200, 9);
  });
});

describe("intensityFactor and tssFromPower", () => {
  it("3600 s example at FTP 250: IF 1.0113, TSS 102.27", () => {
    const np = normalizedPower(ride);
    expect(intensityFactor(np, 250)).toBeCloseTo(1.0113, 4);
    expect(tssFromPower(np, 250, 3600)).toBeCloseTo(102.27, 2);
  });
  it("constant 200 W for an hour at FTP 250: IF 0.8, TSS 64", () => {
    expect(intensityFactor(200, 250)).toBeCloseTo(0.8, 10);
    expect(tssFromPower(200, 250, 3600)).toBeCloseTo(64, 10);
  });
  it("is null for missing NP or FTP", () => {
    expect(intensityFactor(null, 250)).toBeNull();
    expect(intensityFactor(200, null)).toBeNull();
    expect(intensityFactor(200, 0)).toBeNull();
    expect(intensityFactor(Number.NaN, 250)).toBeNull();
    expect(tssFromPower(null, 250, 3600)).toBeNull();
    expect(tssFromPower(200, 250, Number.NaN)).toBeNull();
  });
});

describe("workKj", () => {
  it("3600 s example is 720 kJ", () => {
    expect(workKj(ride)).toBeCloseTo(720, 9);
  });
  it("skips nulls and is null for empty or all-null", () => {
    expect(workKj([100, null, 200])).toBeCloseTo(0.3, 9);
    expect(workKj([])).toBeNull();
    expect(workKj(fill(10, null))).toBeNull();
  });
});

describe("meanMaxPower", () => {
  const stream = [...fill(10, 100), ...fill(5, 300), ...fill(10, 100)];
  it("10 × 100, 5 × 300, 10 × 100: MMP(5) 300, MMP(15) 166.67, 30 s+ absent", () => {
    const mmp = meanMaxPower(stream);
    expect(mmp[5]).toBeCloseTo(300, 9);
    expect(mmp[15]).toBeCloseTo(166.67, 2);
    expect(Object.keys(mmp).map(Number)).toEqual([5, 15]);
    for (const d of STANDARD_DURATIONS_S.filter((d) => d >= 30)) expect(mmp[d]).toBeUndefined();
  });
  it("accepts custom durations and skips invalid ones", () => {
    expect(meanMaxPower(stream, [1, 25, 0, 2.5, 26])).toEqual({ 1: 300, 25: 140 });
  });
  it("is empty for empty input and 0 for all-null", () => {
    expect(meanMaxPower([])).toEqual({});
    expect(meanMaxPower(fill(5, null))).toEqual({ 5: 0 });
  });
});
