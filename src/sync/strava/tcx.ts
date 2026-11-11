/** TCX track to 1 Hz channels (AI-640). Regex-based, no XML library; any namespace prefix. Pure. */
import type { Channels } from "../types.js";
import { elementNumber, elementText, pointsToChannels, type TrackPoint } from "./points.js";

/**
 * `<Trackpoint>` with `Time`, `LatitudeDegrees`, `LongitudeDegrees`, `AltitudeMeters`,
 * `DistanceMeters`, `HeartRateBpm/Value`, `Cadence` and `Watts`.
 */
export function tcxToChannels(xml: string, startedAt: string): Channels {
  const points: TrackPoint[] = [];
  const re = /<(?:[\w.-]+:)?Trackpoint\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Trackpoint\s*>/g;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    const body = m[1];
    const time = elementText(body, "Time");
    if (time === null) continue;
    const hr = /<(?:[\w.-]+:)?HeartRateBpm\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?HeartRateBpm\s*>/.exec(body);
    points.push({
      time,
      lat: elementNumber(body, "LatitudeDegrees"),
      lng: elementNumber(body, "LongitudeDegrees"),
      altitude: elementNumber(body, "AltitudeMeters"),
      distance: elementNumber(body, "DistanceMeters"),
      heart_rate: hr === null ? null : elementNumber(hr[1], "Value"),
      cadence: elementNumber(body, "Cadence"),
      power: elementNumber(body, "Watts"),
    });
  }
  return pointsToChannels(points, startedAt);
}
