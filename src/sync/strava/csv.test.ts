import { describe, expect, it } from "vitest";
import csvText from "./__fixtures__/activities.csv?raw";
import {
  dedupeHeader,
  parseActivitiesCsv,
  parseActivitiesCsvWithHeader,
  parseCsvRecords,
  parseStravaDate,
  requiredColumnsMissing,
  rideEnvironment,
} from "./csv.js";
import { stravaToProvider } from "./normalize.js";

describe("parseCsvRecords", () => {
  it("handles quoted commas, doubled quotes, newlines and CRLF", () => {
    expect(parseCsvRecords('a,"b,c","d ""e""\r\nf"\r\n1,,3\n\n')).toEqual([
      ["a", "b,c", 'd "e"\r\nf'],
      ["1", "", "3"],
    ]);
  });

  it("strips a BOM and keeps a last record without a newline", () => {
    expect(parseCsvRecords("﻿x,y\n1,2")).toEqual([
      ["x", "y"],
      ["1", "2"],
    ]);
  });
});

describe("dedupeHeader", () => {
  it("numbers repeated names from (2)", () => {
    expect(dedupeHeader(["A", "B", "A", "A", "B"])).toEqual(["A", "B", "A (2)", "A (3)", "B (2)"]);
  });
});

describe("parseStravaDate", () => {
  it("parses the export form as UTC", () => {
    expect(parseStravaDate("Jan 5, 2015, 2:30:00 PM")).toBe("2015-01-05T14:30:00.000Z");
    expect(parseStravaDate("Feb 10, 2015, 7:05:09 AM")).toBe("2015-02-10T07:05:09.000Z");
    expect(parseStravaDate("Dec 31, 2020, 12:00:01 AM")).toBe("2020-12-31T00:00:01.000Z");
    expect(parseStravaDate("Jun 1, 2021, 12:59:59 PM")).toBe("2021-06-01T12:59:59.000Z");
  });

  it("rejects anything else", () => {
    for (const bad of ["not a date", "", "2015-01-05T14:30:00Z", "Foo 5, 2015, 2:30:00 PM", "Feb 30, 2015, 1:00:00 AM", "Jan 5, 2015, 13:00:00 PM"]) {
      expect(parseStravaDate(bad)).toBeNull();
    }
    expect(parseStravaDate(undefined)).toBeNull();
  });
});

describe("parseActivitiesCsv (fixture)", () => {
  const rows = parseActivitiesCsv(csvText);

  it("(a) maps the columns, duplicates included", () => {
    expect(rows).toHaveLength(5);
    const [ride] = rows;
    expect(ride).toMatchObject({
      id: "1001",
      startedAt: "2015-01-05T14:30:00.000Z",
      name: "Synthetic Ride One",
      type: "Ride",
      elapsedS: 3701, // Elapsed Time (2), not the first Elapsed Time
      movingS: 3600,
      distanceM: 30500, // Distance (2) in metres, not the km column
      elevationGainM: 250,
      avgSpeedMps: 8.47,
      maxSpeedMps: 15.2,
      avgPowerW: 180,
      maxPowerW: 600,
      avgHrBpm: 140,
      maxHrBpm: 172, // Max Heart Rate (2)
      avgCadenceRpm: 85,
      calories: 900,
      filename: "activities/1001.gpx",
    });
    expect(ride.raw["Activity Description"]).toBe('First line, with a comma\nsecond line with "quotes"');
    expect(ride.raw["Elapsed Time"]).toBe("3700");
    expect(ride.raw["Distance"]).toBe("30.5");
    expect(ride.raw["Relative Effort"]).toBe("45");
    expect(ride.raw["Relative Effort (2)"]).toBe("45.0");
    expect(ride.raw["Weighted Average Power"]).toBe("200.0");
  });

  it("falls back to the first column and gives null for empty cells", () => {
    const ride2 = rows[3];
    expect(ride2.elapsedS).toBe(5400); // Elapsed Time (2) empty
    expect(ride2.maxHrBpm).toBe(165); // Max Heart Rate (2) empty
    expect(ride2.avgPowerW).toBeNull();
    expect(ride2.avgCadenceRpm).toBeNull();
    expect(rows[2].maxHrBpm).toBeNull();
    expect(rows[4].startedAt).toBeNull();
  });

  it("(b) filters by ride type; Virtual Ride is indoor", () => {
    expect(rows.map((r) => rideEnvironment(r.type))).toEqual(["outdoor", null, "indoor", "outdoor", "outdoor"]);
    for (const t of ["Ride", "E-Bike Ride", "Gravel Ride", "Mountain Bike Ride"]) expect(rideEnvironment(t)).toBe("outdoor");
    for (const t of ["Run", "Walk", "Workout", "VirtualRide", null, "toString"]) expect(rideEnvironment(t)).toBeNull();
  });

  it("gives null for a cell missing from a short row", () => {
    const [row] = parseActivitiesCsv("Activity ID,Activity Date,Activity Type,Filename,Calories\n7,\"Jan 1, 2020, 1:00:00 AM\",Ride");
    expect(row.filename).toBeNull();
    expect(row.calories).toBeNull();
    expect(row.raw.Calories).toBe("");
  });
});

describe("requiredColumnsMissing", () => {
  it("is empty for the fixture", () => {
    expect(requiredColumnsMissing(parseActivitiesCsvWithHeader(csvText).header)).toEqual([]);
  });

  it("lists the absent required columns", () => {
    expect(requiredColumnsMissing(["Activity ID", "Activity Name"])).toEqual(["Activity Date", "Activity Type", "Filename"]);
  });
});

describe("stravaToProvider", () => {
  it("keeps every column in providerPayload and nothing extra in typed columns", () => {
    const row = parseActivitiesCsv(csvText)[2];
    const p = stravaToProvider(row, "indoor");
    expect(p).toMatchObject({
      source: "strava_export",
      sourceId: "1003",
      startedAt: "2015-03-01T12:00:00.000Z",
      timezone: null,
      subType: "Virtual Ride",
      environment: "indoor",
      title: "Synthetic Virtual Ride",
      workKj: null,
      distanceM: 20000,
    });
    expect(p.providerPayload).toBe(row.raw);
  });

  it("throws on a row without a parsed date", () => {
    expect(() => stravaToProvider(parseActivitiesCsv(csvText)[4], "outdoor")).toThrow();
  });
});
