import { dateFromDayNumber, dayNumber, localDate } from "./dates";

describe("dates", () => {
  it("round-trips day numbers and rejects malformed dates", () => {
    expect(dayNumber("1970-01-02")).toBe(1);
    expect(dateFromDayNumber(dayNumber("2026-11-11") as number)).toBe("2026-11-11");
    expect(dayNumber("2026-02-30")).toBeNull();
    expect(dayNumber("2026-13-01")).toBeNull();
    expect(dayNumber("junk")).toBeNull();
  });
  it("gives the local calendar date", () => {
    expect(localDate("2026-11-02T03:00:00Z", "Etc/GMT+5")).toBe("2026-11-01");
    expect(localDate("2026-11-02T03:00:00Z", "Asia/Tokyo")).toBe("2026-11-02");
    expect(localDate("2026-11-02T03:00:00Z", undefined)).toBe("2026-11-02");
    expect(localDate("2026-11-02T03:00:00Z", "Bad/Zone")).toBe("2026-11-02");
    expect(localDate("2026-11-02", "Asia/Tokyo")).toBe("2026-11-02");
    expect(localDate("2026-02-30", "UTC")).toBeNull();
    expect(localDate("", "UTC")).toBeNull();
  });
});
