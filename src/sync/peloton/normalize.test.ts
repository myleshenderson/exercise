import { describe, expect, it } from "vitest";
import {
  CLASS_START,
  FREESTYLE_START,
  OLD_TEST_ID,
  SYNTHETIC_FTP,
  classDetail,
  classWorkout,
  freestyleWorkout,
  graph120,
  workoutHistoryCsv,
} from "./__fixtures__/peloton.js";
import { csvNumber, localMinute, matchCsvRow, parseWorkoutHistoryCsv } from "./csv.js";
import { ftpFromWorkout } from "./ftp.js";
import { distanceToM, graphToChannels, pelotonToProvider, speedToMps } from "./normalize.js";
import { PELOTON_CSV_COLUMNS } from "./types.js";

describe("unit conversions (f)", () => {
  it("converts distance and speed by display unit", () => {
    expect(distanceToM(1, "mi")).toBeCloseTo(1609.344, 9);
    expect(distanceToM(2.5, "km")).toBeCloseTo(2500, 9);
    expect(distanceToM(1, "furlong")).toBeNull();
    expect(speedToMps(20, "mph")).toBeCloseTo(8.9408, 9);
    expect(speedToMps(36, "kph")).toBeCloseTo(10, 9);
    expect(speedToMps(null, "mph")).toBeNull();
  });

  it("maps a class workout with its graph", () => {
    const a = pelotonToProvider(classWorkout, classDetail, graph120, null, true);
    expect(a.source).toBe("peloton");
    expect(a.sourceId).toBe(classWorkout.id);
    expect(a.startedAt).toBe("2026-01-02T12:01:00.000Z");
    expect(a.timezone).toBe("Etc/GMT+5");
    expect(a.environment).toBe("indoor");
    expect(a.subType).toBe("cycling");
    expect(a.title).toBe("2 min FTP Test Ride");
    expect(a.elapsedS).toBe(120);
    expect(a.movingS).toBe(120);
    expect(a.workKj).toBeCloseTo(30, 9); // 30000 J
    expect(a.calories).toBe(25);
    expect(a.distanceM).toBeCloseTo(0.5 * 1609.344, 9);
    expect(a.avgSpeedMps).toBeCloseTo(20 * 0.44704, 9);
    expect(a.maxSpeedMps).toBeCloseTo(25 * 0.44704, 9);
    expect(a.avgPowerW).toBe(104);
    expect(a.maxPowerW).toBe(109);
    expect(a.avgCadenceRpm).toBe(80);
    expect(a.avgHrBpm).toBe(130);
    expect(a.maxHrBpm).toBe(140);
    expect(a.providerPayload).toEqual({ workout: classDetail, isFtpTest: true, csv: null });
    expect((a.providerPayload as { workout: unknown }).workout).toBe(classDetail);
  });

  it("uses start_time, never device_time_created_at, and is_outdoor for the environment", () => {
    const a = pelotonToProvider({ ...classWorkout, is_outdoor: true }, null, null, null);
    expect(Date.parse(a.startedAt) / 1000).toBe(CLASS_START);
    expect(a.environment).toBe("outdoor");
    expect(a.providerPayload).toEqual({ workout: { ...classWorkout, is_outdoor: true }, isFtpTest: null, csv: null });
  });

  it("falls back to the CSV row without a graph, and to null without either", () => {
    const rows = parseWorkoutHistoryCsv(workoutHistoryCsv);
    const a = pelotonToProvider(freestyleWorkout, null, null, rows[2]);
    expect(a.title).toBe("10 min Just Ride");
    expect(a.distanceM).toBeCloseTo(3.1 * 1609.344, 9);
    expect(a.avgPowerW).toBe(110);
    expect(a.avgCadenceRpm).toBe(78);
    expect(a.avgSpeedMps).toBeCloseTo(18 * 0.44704, 9);
    expect(a.avgHrBpm).toBeNull(); // empty cell
    expect(a.workKj).toBeCloseTo(66, 9);
    const bare = pelotonToProvider(freestyleWorkout, null, null, null);
    expect(bare.distanceM).toBeNull();
    expect(bare.avgPowerW).toBeNull();
  });

  it("graphToChannels places samples by second, nulls the gaps, maps slugs and converts mph", () => {
    const ch = graphToChannels(graph120);
    expect(Object.keys(ch).sort()).toEqual(["cadence", "heart_rate", "power", "resistance", "speed"]);
    for (const values of Object.values(ch)) expect(values).toHaveLength(121);
    expect(ch.power?.[0]).toBeNull(); // offset 0 = start_time; first sample at second 1
    expect(ch.power?.[1]).toBe(101);
    expect(ch.power?.[59]).toBe(109);
    expect(ch.power?.[60]).toBeNull(); // missing second
    expect(ch.power?.[61]).toBe(101);
    expect(ch.power?.[120]).toBe(100);
    expect(ch.heart_rate?.[30]).toBeNull(); // null value kept
    expect(ch.heart_rate?.[31]).toBe(130);
    expect(ch.speed?.[5]).toBeCloseTo(8.9408, 9);
    expect(ch.resistance?.[5]).toBe(40);

    const kph = graphToChannels({ ...graph120, metrics: [{ slug: "speed", display_unit: "kph", values: [36], average_value: 36 }], seconds_since_pedaling_start: [0] });
    expect(kph.speed?.[0]).toBeCloseTo(10, 9);
  });
});

describe("CSV", () => {
  it("parses the 18 columns, quoted fields and CRLF", () => {
    const rows = parseWorkoutHistoryCsv(workoutHistoryCsv);
    expect(rows).toHaveLength(3);
    expect(Object.keys(rows[0])).toEqual([...PELOTON_CSV_COLUMNS]);
    expect(rows[0]["Instructor Name"]).toBe("Instructor, Synthetic");
    expect(rows[0]["Avg. Resistance"]).toBe("45%");
    expect(csvNumber(rows[0]["Avg. Resistance"])).toBe(45);
    expect(rows[2]["Avg. Pace (min/mi)"]).toBe("");
    expect(parseWorkoutHistoryCsv('Workout Timestamp,Title\n"a ""b""\nc",x')[0].Title).toBe("x");
    expect(parseWorkoutHistoryCsv('Workout Timestamp,Title\n"a ""b""\nc",x')[0]["Workout Timestamp"]).toBe('a "b"\nc');
  });

  it("(g) a start_time maps to the right Etc/GMT+5 local minute", () => {
    expect(localMinute(CLASS_START, "Etc/GMT+5")).toBe("2026-01-02 07:01");
    expect(localMinute(CLASS_START + 59, "Etc/GMT+5")).toBe("2026-01-02 07:01");
    expect(localMinute(FREESTYLE_START, "Etc/GMT+5")).toBe("2026-01-01 10:30");
    // Midnight wraps the date back a day.
    expect(localMinute(Date.parse("2026-03-01T03:00:00Z") / 1000, "Etc/GMT+5")).toBe("2026-02-28 22:00");
    expect(localMinute(CLASS_START, "Etc/GMT-2")).toBe("2026-01-02 14:01");
  });

  it("matches on minute and title, breaks the duplicate-timestamp tie on Total Output", () => {
    const rows = parseWorkoutHistoryCsv(workoutHistoryCsv);
    expect(matchCsvRow(classWorkout, rows)).toBe(rows[1]); // 30 kJ, not the 45 kJ row listed first
    expect(matchCsvRow({ ...classWorkout, total_work: 44000 }, rows)).toBe(rows[0]);
    expect(matchCsvRow(freestyleWorkout, rows)).toBe(rows[2]);
    expect(matchCsvRow({ ...classWorkout, start_time: CLASS_START + 60 }, rows)).toBeNull();
    expect(matchCsvRow({ ...classWorkout, ride: { title: "Other" } }, rows)).toBeNull();
    expect(matchCsvRow({ ...classWorkout, timezone: "Not/AZone" }, rows)).toBeNull();
  });
});

describe("FTP (j)", () => {
  const startedAt = "2026-01-02T12:01:00.000Z";

  it("maps ftp_workout_source to peloton_test, dated from the known test start", () => {
    const known = new Map([[OLD_TEST_ID, "2025-12-01T11:00:00.000Z"]]);
    expect(ftpFromWorkout(classDetail, startedAt, known)).toEqual({
      effectiveFrom: "2025-12-01T11:00:00.000Z",
      ftpW: SYNTHETIC_FTP,
      source: "peloton_test",
      sourceRef: OLD_TEST_ID,
    });
    expect(ftpFromWorkout(classDetail, startedAt, new Map())?.effectiveFrom).toBe(startedAt);
  });

  it("maps ftp_manual_source to peloton_manual and rejects other sources and FTP <= 0", () => {
    const manual = { ...classDetail, ftp_info: { ftp: 99, ftp_source: "ftp_manual_source", ftp_workout_id: null } };
    expect(ftpFromWorkout(manual, startedAt, new Map())).toEqual({ effectiveFrom: startedAt, ftpW: 99, source: "peloton_manual", sourceRef: null });
    expect(ftpFromWorkout({ ...classDetail, ftp_info: { ftp: 99, ftp_source: "ftp_estimated_source", ftp_workout_id: null } }, startedAt, new Map())).toBeNull();
    expect(ftpFromWorkout({ ...classDetail, ftp_info: { ftp: 0, ftp_source: "ftp_manual_source", ftp_workout_id: null } }, startedAt, new Map())).toBeNull();
    expect(ftpFromWorkout({ ...classDetail, ftp_info: null }, startedAt, new Map())).toBeNull();
    expect(ftpFromWorkout(classWorkout, startedAt, new Map())).toBeNull();
  });
});
