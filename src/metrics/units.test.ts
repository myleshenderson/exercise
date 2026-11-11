import { cToF, formatDistance, formatElevation, formatSpeed, formatWeight, kgToLb, mpsToMph, mToFt, mToMi } from "./units";

describe("conversions", () => {
  it("convert with the exact factors", () => {
    expect(mToMi(1609.344)).toBe(1);
    expect(mToFt(0.3048)).toBe(1);
    expect(kgToLb(0.45359237)).toBe(1);
    expect(mpsToMph(1)).toBeCloseTo(2.2369362920544, 12);
    expect(mToMi(0)).toBe(0);
    expect(cToF(0)).toBe(32);
    expect(cToF(100)).toBe(212);
    expect(cToF(-40)).toBe(-40);
  });
});

describe("formatting", () => {
  it("defaults to imperial", () => {
    expect(formatDistance(104_130)).toBe("64.7 mi");
    expect(formatElevation(319.43)).toBe("1,048 ft");
    expect(formatSpeed(8.3)).toBe("18.6 mph");
    expect(formatWeight(80)).toBe("176.4 lb");
  });
  it("formats metric", () => {
    expect(formatDistance(104_130, "metric")).toBe("104.1 km");
    expect(formatElevation(2777.4, "metric")).toBe("2,777 m");
    expect(formatSpeed(8.3, "metric")).toBe("29.9 km/h");
    expect(formatWeight(80, "metric")).toBe("80.0 kg");
  });
  it("never shows a negative zero", () => {
    expect(formatElevation(-0.01, "metric")).toBe("0 m");
    expect(formatDistance(-1, "metric")).toBe("0.0 km");
  });
  it("shows a dash for missing values", () => {
    for (const f of [formatDistance, formatElevation, formatSpeed, formatWeight]) {
      expect(f(null)).toBe("—");
      expect(f(Number.NaN, "metric")).toBe("—");
    }
  });
});
