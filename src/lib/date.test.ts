import { formatSessionDate } from "./date";

test("formats an ISO date as 'Weekday, Mon D'", () => {
  // 2026-06-22 is a Monday
  expect(formatSessionDate("2026-06-22")).toBe("Monday, Jun 22");
});

test("formats single-digit day without padding", () => {
  // 2026-06-01 is a Monday
  expect(formatSessionDate("2026-06-01")).toBe("Monday, Jun 1");
});
