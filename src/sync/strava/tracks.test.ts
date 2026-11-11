import { gzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { BT, data, def, encodeFit } from "../../fit/testing/encodeFit.js";
import gpxText from "./__fixtures__/ride.gpx?raw";
import tcxText from "./__fixtures__/ride.tcx?raw";
import { gpxToChannels } from "./gpx.js";
import { EARTH_RADIUS_M, haversineM, pointsToChannels, xmlText } from "./points.js";
import { stravaStream, streamKind } from "./streams.js";
import { tcxToChannels } from "./tcx.js";

const enc = new TextEncoder();
/** Seconds from the Unix epoch to the FIT epoch (1989-12-31T00:00:00Z). */
const FIT_EPOCH_S = 631065600;

describe("gpxToChannels", () => {
  const start = "2015-01-05T14:30:00.000Z";
  const ch = gpxToChannels(gpxText, start);

  it("lays the 60 points out at 1 Hz with every channel", () => {
    for (const c of ["lat", "lng", "altitude", "heart_rate", "cadence", "power", "distance"] as const) {
      expect(ch[c]).toHaveLength(60);
    }
    expect(ch.heart_rate![0]).toBe(120);
    expect(ch.heart_rate![59]).toBe(179);
    expect(ch.power![10]).toBe(210);
    expect(ch.cadence![3]).toBe(83);
    expect(ch.altitude![2]).toBe(101);
    expect(ch.lat![1]).toBeCloseTo(45.0001, 6);
  });

  it("computes a cumulative haversine distance within 0.5 %", () => {
    const expected = (EARTH_RADIUS_M * 59 * 0.0001 * Math.PI) / 180;
    expect(ch.distance![0]).toBe(0);
    expect(Math.abs(ch.distance![59]! - expected) / expected).toBeLessThan(0.005);
  });

  it("drops points before startedAt", () => {
    const later = gpxToChannels(gpxText, "2015-01-05T14:30:10.000Z");
    expect(later.heart_rate).toHaveLength(50);
    expect(later.heart_rate![0]).toBe(130);
  });

  it("returns no channels for a GPX without timed points", () => {
    expect(gpxToChannels('<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>', start)).toEqual({});
  });
});

describe("tcxToChannels", () => {
  const ch = tcxToChannels(tcxText, "2015-03-01T12:00:00.000Z");

  it("reads Watts under an ns3: prefix; later point in a second wins; gaps are null", () => {
    expect(ch.power).toEqual([150, 170, null, null, 200]);
    expect(ch.heart_rate).toEqual([110, 112, null, null, 115]);
    expect(ch.cadence).toEqual([85, 87, null, null, 90]);
    expect(ch.distance).toEqual([0, 12, null, null, 30]);
  });

  it("omits all-null channels", () => {
    expect(ch.lat).toBeUndefined();
    expect(ch.altitude).toBeUndefined();
    expect(ch.speed).toBeUndefined();
  });
});

describe("pointsToChannels and haversineM", () => {
  it("keeps an out-of-range numeric entity as text", () => {
    expect(xmlText("a &#99999999; &amp; &#65;")).toBe("a &#99999999; & A");
  });

  it("floors seconds", () => {
    const t0 = "2020-01-01T00:00:00.000Z";
    expect(pointsToChannels([{ time: "2020-01-01T00:00:00.900Z", power: 1 }, { time: "2020-01-01T00:00:02.100Z", power: 2 }], t0)).toEqual({
      power: [1, null, 2],
    });
  });

  it("measures one degree of latitude", () => {
    expect(haversineM(0, 0, 1, 0)).toBeCloseTo((EARTH_RADIUS_M * Math.PI) / 180, 3);
  });
});

describe("stravaStream", () => {
  const startedAt = "2015-04-02T06:15:00.000Z";
  const t0 = Date.parse(startedAt) / 1000 - FIT_EPOCH_S;
  // record: timestamp, power (W), heart_rate (bpm)
  const fit = encodeFit([
    def(0, 20, [
      { num: 253, baseType: BT.uint32 },
      { num: 7, baseType: BT.uint16 },
      { num: 3, baseType: BT.uint8 },
    ]),
    data(0, [t0 + 2, 200, 120]),
    data(0, [t0 + 3, 210, 121]),
    data(0, [t0 + 5, 220, 122]),
  ]);

  it("recognises the kinds", () => {
    expect(streamKind("activities/1.fit.gz")).toEqual({ kind: "fit", gzipped: true });
    expect(streamKind("activities/1.GPX")).toEqual({ kind: "gpx", gzipped: false });
    expect(streamKind("activities/1.tcx.gz")).toEqual({ kind: "tcx", gzipped: true });
    expect(streamKind("activities/1.jpg")).toBeNull();
  });

  it("decodes a gzipped FIT, carrying the first record's offset", () => {
    expect(stravaStream("a/1.fit.gz", gzipSync(fit), startedAt)).toEqual({
      channels: { power: [200, 210, null, 220], heart_rate: [120, 121, null, 122] },
      offsetS: 2,
      offsetOk: true,
    });
    expect(stravaStream("a/1.fit", fit, startedAt)?.offsetS).toBe(2);
  });

  it("decodes gzipped GPX and TCX", () => {
    expect(stravaStream("a/1.gpx.gz", gzipSync(enc.encode(gpxText)), "2015-01-05T14:30:00.000Z")?.channels.power).toHaveLength(60);
    expect(stravaStream("a/1.tcx.gz", gzipSync(enc.encode(tcxText)), "2015-03-01T12:00:00.000Z")?.channels.power).toEqual([
      150,
      170,
      null,
      null,
      200,
    ]);
  });

  it("gives null for a file that does not parse or is unsupported", () => {
    expect(stravaStream("a/1.fit", new Uint8Array([1, 2, 3]), startedAt)).toBeNull();
    expect(stravaStream("a/1.fit.gz", fit, startedAt)).toBeNull(); // not gzip
    expect(stravaStream("a/1.gpx", enc.encode("garbage"), startedAt)).toBeNull();
    expect(stravaStream("a/1.jpg", fit, startedAt)).toBeNull();
  });
});
