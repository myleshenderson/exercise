import {
  compareText,
  compileIlike,
  isoWeekStart,
  roundDecimal,
  roundRatio,
  timestampMicros,
  timestampToUtcDate,
  toDecimal,
  addDecimal,
  dayNumber,
  mulDecimalInt,
} from "./sqlSemantics.js";

describe("sqlSemantics", () => {
  it("round(numeric) is exact and rounds half away from zero", () => {
    // 0.1*3 + 1.4*3 = 4.5 exactly in numeric -> 5; float arithmetic gives 4.499999999999999 -> 4.
    expect(roundDecimal(addDecimal(mulDecimalInt(toDecimal(0.1), 3), mulDecimalInt(toDecimal(1.4), 3)))).toBe(5);
    expect(roundDecimal(mulDecimalInt(toDecimal(2.25), 2))).toBe(5); // 4.5 -> 5
    expect(roundDecimal(mulDecimalInt(toDecimal(-2.25), 2))).toBe(-5); // -4.5 -> -5
    expect(roundRatio(1005n, 100n, 1)).toBe(10.1); // 10.05 -> 10.1
    expect(roundRatio(25n, 3n, 1)).toBe(8.3);
    expect(toDecimal(1e21)).toEqual({ units: 10n ** 21n, scale: 0 });
    expect(toDecimal(1e-7)).toEqual({ units: 1n, scale: 7 });
  });

  it("date_trunc('week') lands on the ISO Monday", () => {
    expect(isoWeekStart("2026-08-24")).toBe("2026-08-24"); // Monday
    expect(isoWeekStart("2026-08-30")).toBe("2026-08-24"); // Sunday
    expect(isoWeekStart("2026-08-31")).toBe("2026-08-31"); // next Monday
    expect(isoWeekStart("2027-01-01")).toBe("2026-12-28"); // across a year
    expect(dayNumber("0050-01-02") - dayNumber("0049-12-31")).toBe(2); // no 1900s mapping of years 0-99
  });

  it("timestamptz parsing keeps microseconds and offsets", () => {
    expect(timestampMicros("2026-08-01T00:00:00.000002+00:00") - timestampMicros("2026-08-01T00:00:00.000001Z")).toBe(1n);
    expect(timestampMicros("2026-08-01T02:00:00+02:00")).toBe(timestampMicros("2026-08-01T00:00:00Z"));
    expect(timestampMicros("2026-08-01 00:00:00+00")).toBe(timestampMicros("2026-08-01T00:00:00Z"));
    expect(timestampToUtcDate("2026-08-01T23:30:00-05:00")).toBe("2026-08-02");
    // input beyond microseconds rounds to the nearest microsecond
    expect(timestampMicros("2026-08-01T00:00:00.0000025Z") - timestampMicros("2026-08-01T00:00:00Z")).toBe(3n);
    expect(timestampMicros("2026-08-01T00:00:00.00000249Z") - timestampMicros("2026-08-01T00:00:00Z")).toBe(2n);
    expect(timestampToUtcDate("1969-12-31T23:59:59.5Z")).toBe("1969-12-31");
  });

  it("ILIKE patterns follow Postgres wildcard and escape rules", () => {
    expect(compileIlike("%bench%").test("Incline BENCH press")).toBe(true);
    expect(compileIlike("%b_nch%").test("Bench")).toBe(true);
    expect(compileIlike("%a\\%%").test("50a% off")).toBe(true);
    expect(compileIlike("%a\\%%").test("ab")).toBe(false);
    expect(compileIlike("%x%").test("line\nx")).toBe(true);
    expect(compileIlike("%pull-up (wide)%").test("Weighted Pull-Up (Wide) [v2]")).toBe(true);
    expect(() => compileIlike("abc\\")).toThrow("LIKE pattern must not end with escape character");
  });

  it("text ordering follows en_US (case-insensitive first) then code point", () => {
    expect(compareText("bench", "Curl")).toBeLessThan(0);
    expect(compareText("Row", "row")).not.toBe(0);
  });
});
