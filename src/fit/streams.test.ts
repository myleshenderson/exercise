import { describe, expect, it } from "vitest";
import { decodeFit, FitError, toStreams } from "./index";
import { MAX_SPAN_SECONDS } from "./streams";
import type { FitMessages, FitRecord } from "./types";
import { BT, data, def, encodeFit } from "./testing/encodeFit";

const T0 = 1_000_000_000; // FIT seconds
const U0 = 1_631_065_600; // the same instant in Unix seconds

function rec(timestamp: number | null, extra: Partial<FitRecord> = {}): FitRecord {
  return {
    timestamp,
    position_lat: null,
    position_long: null,
    altitude: null,
    heart_rate: null,
    cadence: null,
    distance: null,
    speed: null,
    power: null,
    temperature: null,
    enhanced_speed: null,
    enhanced_altitude: null,
    ...extra,
  };
}

function msgs(records: FitRecord[], rest: Partial<FitMessages> = {}): FitMessages {
  return { records, laps: [], sessions: [], events: [], sets: [], ...rest };
}

describe("toStreams", () => {
  it("lays a 10-record ride with a 3 s gap into 13 slots with 3 null rows", () => {
    const seconds = [0, 1, 2, 3, 4, 8, 9, 10, 11, 12];
    const items = [
      def(0, 20, [
        { num: 253, baseType: BT.uint32 },
        { num: 0, baseType: BT.sint32 },
        { num: 1, baseType: BT.sint32 },
        { num: 5, baseType: BT.uint32 },
        { num: 73, baseType: BT.uint32 },
        { num: 78, baseType: BT.uint32 },
        { num: 13, baseType: BT.sint8 },
      ]),
      ...seconds.map((s) => data(0, [T0 + s, 536870912, 268435456, s * 500, 5000, 3000 + s, 20])),
    ];
    const a = toStreams(decodeFit(encodeFit(items)));
    const N = null;
    expect(a.startTime).toBe("2021-09-08T01:46:40.000Z");
    expect(a.channels).toEqual({
      timestamp: [U0, U0 + 1, U0 + 2, U0 + 3, U0 + 4, N, N, N, U0 + 8, U0 + 9, U0 + 10, U0 + 11, U0 + 12],
      lat: [45, 45, 45, 45, 45, N, N, N, 45, 45, 45, 45, 45],
      lng: [22.5, 22.5, 22.5, 22.5, 22.5, N, N, N, 22.5, 22.5, 22.5, 22.5, 22.5],
      distance: [0, 5, 10, 15, 20, N, N, N, 40, 45, 50, 55, 60],
      speed: [5, 5, 5, 5, 5, N, N, N, 5, 5, 5, 5, 5],
      altitude: [100, 100.2, 100.4, 100.6, 100.8, N, N, N, 101.6, 101.8, 102, 102.2, 102.4],
      temperature: [20, 20, 20, 20, 20, N, N, N, 20, 20, 20, 20, 20],
    });
    // No power, cadence or heart_rate sensor: those channels are omitted.
    expect(Object.keys(a.channels)).not.toContain("power");
    expect(Object.keys(a.channels)).not.toContain("heart_rate");
  });

  it("prefers enhanced speed/altitude and falls back to the plain fields", () => {
    const a = toStreams(
      msgs([
        rec(U0, { speed: 4, enhanced_speed: 4.5, altitude: 10, enhanced_altitude: 12 }),
        rec(U0 + 1, { speed: 4, altitude: 10 }),
      ]),
    );
    expect(a.channels.speed).toEqual([4.5, 4]);
    expect(a.channels.altitude).toEqual([12, 10]);
  });

  it("keeps the last record in a second and floors sub-second times", () => {
    const a = toStreams(
      msgs([
        rec(U0, { power: 100 }),
        rec(U0 + 0.6, { power: 150 }),
        rec(U0 + 1.2, { power: 200, cadence: 85, heart_rate: 130 }),
        rec(null, { power: 999 }),
      ]),
    );
    expect(a.channels).toEqual({
      timestamp: [U0, U0 + 1],
      power: [150, 200],
      cadence: [null, 85],
      heart_rate: [null, 130],
    });
  });

  it("passes laps, sets and the first session through", () => {
    const lap = { timestamp: U0 + 9, start_time: U0, total_elapsed_time: 9, total_timer_time: 9, total_distance: 50 };
    const session = { ...lap, sport: 2, sub_sport: 7 };
    const set = {
      timestamp: U0 + 5,
      duration: 30,
      repetitions: 8,
      weight: 100,
      set_type: 1,
      start_time: U0,
      category: null,
      category_subtype: null,
    };
    const a = toStreams(msgs([rec(U0)], { laps: [lap], sessions: [session], sets: [set] }));
    expect(a.laps).toEqual([lap]);
    expect(a.sets).toEqual([set]);
    expect(a.session).toEqual(session);
  });

  it("returns no channels and no start time when there are no timed records", () => {
    expect(toStreams(msgs([rec(null)]))).toEqual({
      startTime: null,
      channels: {},
      laps: [],
      sets: [],
      session: null,
    });
  });

  it("refuses a record span longer than 7 days instead of allocating it", () => {
    expect(MAX_SPAN_SECONDS).toBe(604800);
    expect(() => toStreams(msgs([rec(U0), rec(U0 + 604800)]))).toThrow(FitError);
    expect(toStreams(msgs([rec(U0), rec(U0 + 604799)])).channels.timestamp).toHaveLength(604800);
  });
});
