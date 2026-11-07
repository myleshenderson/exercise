import { trainingGaps } from "./trainingGaps.js";
import { session } from "./testFixtures.js";

// Expected values worked by hand from 0005_analysis_rpc.sql:
// distinct performed_on, performed_on - lag(performed_on), ordered by date.
describe("trainingGaps (0005_analysis_rpc.sql)", () => {
  it("returns day gaps between distinct dates in date order, null first", () => {
    const sessions = [
      session("a", "2026-08-05"),
      session("b", "2026-08-01"),
      session("c", "2026-08-01"), // same day collapses
      session("d", "2026-09-02"),
      session("e", "2027-01-01"),
    ];
    expect(trainingGaps({ sessions })).toEqual([
      { performed_on: "2026-08-01", days_since_prev: null },
      { performed_on: "2026-08-05", days_since_prev: 4 },
      { performed_on: "2026-09-02", days_since_prev: 28 },
      { performed_on: "2027-01-01", days_since_prev: 121 },
    ]);
  });

  it("returns a single null-gap row for one date and nothing for empty input", () => {
    expect(trainingGaps({ sessions: [session("a", "2026-08-26")] })).toEqual([
      { performed_on: "2026-08-26", days_since_prev: null },
    ]);
    expect(trainingGaps({ sessions: [] })).toEqual([]);
  });
});
