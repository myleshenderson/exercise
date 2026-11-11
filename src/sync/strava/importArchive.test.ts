import { gzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { BT, data, def, encodeFit } from "../../fit/testing/encodeFit.js";
import type { ExternalActivity } from "../../types.js";
import { activity, context } from "../__fixtures__/rides.js";
import { ingestActivity } from "../ingest.js";
import { createMemorySyncStore, type MemorySyncStore } from "../testing/memoryStore.js";
import csvText from "./__fixtures__/activities.csv?raw";
import gpxText from "./__fixtures__/ride.gpx?raw";
import tcxText from "./__fixtures__/ride.tcx?raw";
import { coveredBy } from "./gap.js";
import { StravaCsvError, importStravaArchive } from "./importArchive.js";

const FIT_EPOCH_S = 631065600;
const RIDE_TWO_START = "2015-04-02T06:15:00.000Z";
const enc = new TextEncoder();

function fitGz(): Uint8Array {
  const t0 = Date.parse(RIDE_TWO_START) / 1000 - FIT_EPOCH_S;
  return gzipSync(
    encodeFit([
      def(0, 20, [
        { num: 253, baseType: BT.uint32 },
        { num: 7, baseType: BT.uint16 },
      ]),
      ...Array.from({ length: 30 }, (_, i) => data(0, [t0 + i, 200])),
    ]),
  );
}

const FILES: Record<string, Uint8Array> = {
  "activities/1001.gpx": enc.encode(gpxText),
  "activities/1002.gpx": enc.encode(gpxText),
  "activities/1003.tcx": enc.encode(tcxText),
  "activities/1004.fit.gz": fitGz(),
};

const readAll = (rel: string) => FILES[rel] ?? null;
const opts = (dryRun = false) => ({ dryRun, ingestContext: context({ manualFtpW: 250 }), defaultTimeZone: "UTC", today: "2015-04-05" });

/** A stored garmin row starting `offsetS` after `iso`. */
async function seedGarmin(store: MemorySyncStore, iso: string, offsetS: number): Promise<ExternalActivity> {
  const startedAt = new Date(Date.parse(iso) + offsetS * 1000).toISOString();
  return store.upsertActivity(ingestActivity(activity({ sourceId: `g-${offsetS}`, startedAt }), null, context()).row);
}

const strava = (s: MemorySyncStore) => [...s.state.activities.values()].filter((a) => a.source === "strava_export");

describe("coveredBy", () => {
  it("matches garmin and peloton rows within ±600 s only", async () => {
    const store = createMemorySyncStore("u");
    const g = await seedGarmin(store, RIDE_TWO_START, -600);
    expect(coveredBy(RIDE_TWO_START, [g])).toBe(g);
    expect(coveredBy(RIDE_TWO_START, [{ ...g, startedAt: new Date(Date.parse(RIDE_TWO_START) + 601_000).toISOString() }])).toBeNull();
    expect(coveredBy(RIDE_TWO_START, [{ ...g, source: "peloton" }])).not.toBeNull();
    expect(coveredBy(RIDE_TWO_START, [{ ...g, source: "strava_export" }])).toBeNull();
  });
});

describe("importStravaArchive", () => {
  it("imports the fixture's rides with their streams and recomputes the daily load", async () => {
    const store = createMemorySyncStore("u");
    const report = await importStravaArchive({ csvText, readFile: readAll }, store, opts());
    expect(report).toMatchObject({ rows: 5, rides: 4, covered: 0, alreadyImported: 0, imported: 3, noStream: 0, unparsedDate: 1 });
    expect(report.sample.map((s) => s.sourceId)).toEqual(["1001", "1003", "1004"]);

    const rows = strava(store);
    expect(rows.map((r) => r.sourceId).sort()).toEqual(["1001", "1003", "1004"]);
    const virtual = rows.find((r) => r.sourceId === "1003")!;
    expect(virtual).toMatchObject({ environment: "indoor", subType: "Virtual Ride", hasPower: true, bestEfforts: null });
    const outdoor = rows.find((r) => r.sourceId === "1001")!;
    expect(outdoor).toMatchObject({ environment: "outdoor", hasPower: true, tssSource: "power", timezone: null });
    expect(store.state.streams.get(outdoor.id)!.map((s) => s.channel).sort()).toEqual(
      ["altitude", "cadence", "distance", "heart_rate", "lat", "lng", "power"],
    );
    const payload = store.state.payloads.get(outdoor.id) as Record<string, string>;
    expect(payload["Weighted Average Power"]).toBe("200.0");
    expect(payload["Relative Effort (2)"]).toBe("45.0");

    expect(report.dailyLoadDays).toBeGreaterThan(0);
    expect(store.state.dailyLoad.has("2015-01-05")).toBe(true);
    expect(store.state.dailyLoad.has("2015-04-05")).toBe(true);
  });

  it("(b) never imports the run", async () => {
    const store = createMemorySyncStore("u");
    await importStravaArchive({ csvText, readFile: readAll }, store, opts());
    expect(strava(store).some((r) => r.sourceId === "1002")).toBe(false);
  });

  it("(c) a ride 599 s from a Garmin row is covered; at 601 s it is imported", async () => {
    const near = createMemorySyncStore("u");
    await seedGarmin(near, RIDE_TWO_START, 599);
    const r1 = await importStravaArchive({ csvText, readFile: readAll }, near, opts());
    expect(r1).toMatchObject({ covered: 1, imported: 2 });
    expect(strava(near).some((r) => r.sourceId === "1004")).toBe(false);

    const far = createMemorySyncStore("u");
    await seedGarmin(far, RIDE_TWO_START, -601);
    const r2 = await importStravaArchive({ csvText, readFile: readAll }, far, opts());
    expect(r2).toMatchObject({ covered: 0, imported: 3 });
    expect(strava(far).some((r) => r.sourceId === "1004")).toBe(true);
  });

  it("(d) a rerun imports nothing", async () => {
    const store = createMemorySyncStore("u");
    await importStravaArchive({ csvText, readFile: readAll }, store, opts());
    const again = await importStravaArchive({ csvText, readFile: readAll }, store, opts());
    expect(again).toMatchObject({ imported: 0, alreadyImported: 3, covered: 0 });
    expect(strava(store)).toHaveLength(3);
  });

  it("a rerun after a failed run still recomputes the daily load of the rides already written", async () => {
    const store = createMemorySyncStore("u");
    await importStravaArchive({ csvText, readFile: readAll }, store, opts());
    store.state.dailyLoad.clear(); // as if the first run died before its recompute
    const again = await importStravaArchive({ csvText, readFile: readAll }, store, opts());
    expect(again.imported).toBe(0);
    expect(store.state.dailyLoad.has("2015-01-05")).toBe(true);
  });

  it("(e) dryRun writes nothing", async () => {
    const store = createMemorySyncStore("u");
    const report = await importStravaArchive({ csvText, readFile: readAll }, store, opts(true));
    expect(report).toMatchObject({ imported: 3, dailyLoadDays: 0 });
    expect(report.sample).toHaveLength(3);
    expect(store.state.activities.size).toBe(0);
    expect(store.state.streams.size).toBe(0);
    expect(store.state.dailyLoad.size).toBe(0);
  });

  it("(f) a missing file gives a summary-only row with flat TSS", async () => {
    const store = createMemorySyncStore("u");
    const readFile = (rel: string) => (rel === "activities/1004.fit.gz" ? null : readAll(rel));
    const report = await importStravaArchive({ csvText, readFile }, store, opts());
    expect(report).toMatchObject({ imported: 3, noStream: 1 });
    const row = strava(store).find((r) => r.sourceId === "1004")!;
    expect(row).toMatchObject({ tssSource: "estimated_flat", hasPower: false, distanceM: 40000, elapsedS: 5400, maxHrBpm: 165 });
    expect(store.state.streams.get(row.id) ?? []).toEqual([]);
  });

  it("counts an unparseable file as noStream", async () => {
    const store = createMemorySyncStore("u");
    const readFile = (rel: string) => (rel === "activities/1003.tcx" ? enc.encode("not xml") : readAll(rel));
    const report = await importStravaArchive({ csvText, readFile }, store, opts());
    expect(report).toMatchObject({ imported: 3, noStream: 1 });
  });

  it("(g) a missing required column stops the import with the column names", async () => {
    const store = createMemorySyncStore("u");
    const noFile = csvText.replace("Filename,", "File,");
    await expect(importStravaArchive({ csvText: noFile, readFile: readAll }, store, opts())).rejects.toThrow(StravaCsvError);
    await expect(importStravaArchive({ csvText: noFile, readFile: readAll }, store, opts())).rejects.toThrow(/Filename/);
    const err = await importStravaArchive({ csvText: "Activity Name\nx\n", readFile: readAll }, store, opts()).catch((e: unknown) => e);
    expect((err as StravaCsvError).missingColumns).toEqual(["Activity ID", "Activity Date", "Activity Type", "Filename"]);
    expect(store.state.activities.size).toBe(0);
  });
});
