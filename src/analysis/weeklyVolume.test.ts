import { weeklyVolume } from "./weeklyVolume.js";
import { session, set } from "./testFixtures.js";

// Expected values worked by hand from 0005_analysis_rpc.sql:
// date_trunc('week', performed_on)::date (ISO Monday), count(distinct s.id),
// round(sum(weight*reps)) over sessions LEFT JOIN session_sets, ordered by week.
describe("weeklyVolume (0005_analysis_rpc.sql)", () => {
  it("buckets sessions into Monday-start weeks across multiple weeks and a year boundary", () => {
    const sessions = [
      session("c", "2026-08-31"), // Monday -> its own week
      session("a", "2026-08-24"), // Monday
      session("b", "2026-08-30"), // Sunday -> same week as a
      session("f", "2026-09-01"), // Tuesday, no sets -> counts in week 08-31
      session("d", "2026-09-09"), // Wednesday, no sets -> week 09-07 with null volume
      session("e", "2026-01-01"), // Thursday -> week of Monday 2025-12-29
    ];
    const sessionSets = [
      set("a", "x", 1, 100, 10), // 1000
      set("a", "x", 2, 50, 5), // 250
      set("b", "x", 1, 102.5, 3), // 307.5
      set("c", "x", 1, 16.4, 3), // 49.2
      set("c", "x", 2, 0.1, 3), // 0.3
      set("e", "x", 1, 20, 10), // 200
      set("not-a-session", "x", 1, 999, 9), // no matching session: ignored
    ];
    expect(weeklyVolume({ sessions, sessionSets })).toEqual([
      { week: "2025-12-29", sessions: 1, total_volume: 200 },
      { week: "2026-08-24", sessions: 2, total_volume: 1558 }, // 1557.5 rounds half away from zero
      { week: "2026-08-31", sessions: 2, total_volume: 50 }, // 49.5 exactly -> 50
      { week: "2026-09-07", sessions: 1, total_volume: null },
    ]);
  });

  it("counts a session once however many sets it has", () => {
    const sessions = [session("a", "2026-08-25")];
    const sessionSets = [set("a", "x", 1, 10, 1), set("a", "x", 2, 10, 1), set("a", "y", 1, 10, 1)];
    expect(weeklyVolume({ sessions, sessionSets })).toEqual([{ week: "2026-08-24", sessions: 1, total_volume: 30 }]);
  });

  it("returns no rows for empty input", () => {
    expect(weeklyVolume({ sessions: [], sessionSets: [] })).toEqual([]);
    expect(weeklyVolume({ sessions: [], sessionSets: [set("a", "x", 1, 10, 1)] })).toEqual([]);
  });
});
