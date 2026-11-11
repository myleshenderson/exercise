/** GPX track to 1 Hz channels (AI-640). Regex-based, no XML library. Pure. */
import type { Channels } from "../types.js";
import { attribute, cumulativeDistance, elementNumber, elementText, pointsToChannels, type TrackPoint } from "./points.js";

const finite = (s: string | null): number | null => {
  if (s === null || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * `<trkpt lat lon>` with `<ele>` and `<time>`, plus extension elements matched by local name
 * `hr`, `cad` and `power` (e.g. `gpxtpx:hr`). Distance is the cumulative haversine.
 */
export function gpxToChannels(xml: string, startedAt: string): Channels {
  const points: TrackPoint[] = [];
  const re = /<(?:[\w.-]+:)?trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?trkpt\s*>)/g;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    const body = m[2] ?? "";
    const time = elementText(body, "time");
    if (time === null) continue;
    points.push({
      time,
      lat: finite(attribute(m[1], "lat")),
      lng: finite(attribute(m[1], "lon")),
      altitude: elementNumber(body, "ele"),
      heart_rate: elementNumber(body, "hr"),
      cadence: elementNumber(body, "cad"),
      power: elementNumber(body, "power"),
    });
  }
  const distance = cumulativeDistance(points);
  return pointsToChannels(
    points.map((p, i) => ({ ...p, distance: distance[i] })),
    startedAt,
  );
}
