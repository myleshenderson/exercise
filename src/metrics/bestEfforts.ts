/** Distance best efforts and the Strava-style personal-records table (decisions 8 and 13). */
import type { Stream } from "./power.js";

export interface BestEffortDistance {
  label: string;
  distanceM: number;
}

/** The 12 distance rows of decision 8, in display order. */
export const bestEffortDistances: readonly BestEffortDistance[] = [
  { label: "5 mile", distanceM: 8046.72 },
  { label: "10K", distanceM: 10000 },
  { label: "10 mile", distanceM: 16093.44 },
  { label: "20K", distanceM: 20000 },
  { label: "30K", distanceM: 30000 },
  { label: "40K", distanceM: 40000 },
  { label: "50K", distanceM: 50000 },
  { label: "80K", distanceM: 80000 },
  { label: "50 mile", distanceM: 80467.2 },
  { label: "90K", distanceM: 90000 },
  { label: "100K", distanceM: 100000 },
  { label: "100 mile", distanceM: 160934.4 },
];

/**
 * Fastest elapsed time (s) to cover `distanceM` given cumulative distance per second
 * (pauses included). For each end second j, the start is interpolated inside the
 * second after the last sample i with cum[i] <= cum[j] − D. Null samples are skipped.
 * Assumes cumulative distance never decreases. `null` when the ride is shorter than D.
 */
export function fastestDistance(cumDistanceM: Stream, distanceM: number): number | null {
  if (!(distanceM > 0)) return null;
  const idx: number[] = [];
  cumDistanceM.forEach((v, i) => {
    if (typeof v === "number" && Number.isFinite(v)) idx.push(i);
  });
  const cum = (k: number) => cumDistanceM[idx[k]] as number;
  let best = Infinity;
  let p = 0;
  for (let q = 1; q < idx.length; q++) {
    const target = cum(q) - distanceM;
    if (cum(0) > target) continue;
    while (p + 1 < q && cum(p + 1) <= target) p++;
    // cum(p) <= target < cum(p + 1), p + 1 <= q
    const i = idx[p];
    const next = idx[p + 1];
    const start = i + ((next - i) * (target - cum(p))) / (cum(p + 1) - cum(p));
    const elapsed = idx[q] - start;
    if (elapsed < best) best = elapsed;
  }
  return best === Infinity ? null : best;
}

export interface RecordRide {
  id: string;
  environment: "outdoor" | "indoor" | string;
  distanceM: number | null;
  elevationGainM: number | null;
  biggestClimbM: number | null;
  cumDistanceM?: Stream | null;
}

export interface RecordValue {
  value: number;
  activityId: string;
}

export interface PersonalRecords {
  longestRideM: RecordValue | null;
  biggestClimbM: RecordValue | null;
  mostElevationM: RecordValue | null;
  /** One row per `bestEffortDistances` entry, same order; value is elapsed seconds. */
  distances: (BestEffortDistance & { record: RecordValue | null })[];
}

function better(current: RecordValue | null, value: number | null | undefined, id: string, lowerWins: boolean) {
  if (typeof value !== "number" || !Number.isFinite(value)) return current;
  if (current === null || (lowerWins ? value < current.value : value > current.value)) {
    return { value, activityId: id };
  }
  return current;
}

/** The 15 best-effort rows over outdoor rides only (indoor rides never hold a record). */
export function personalRecords(rides: readonly RecordRide[]): PersonalRecords {
  let longest: RecordValue | null = null;
  let climb: RecordValue | null = null;
  let elevation: RecordValue | null = null;
  const distanceRecords: (RecordValue | null)[] = bestEffortDistances.map(() => null);
  for (const ride of rides) {
    if (ride.environment !== "outdoor") continue;
    longest = better(longest, ride.distanceM, ride.id, false);
    climb = better(climb, ride.biggestClimbM, ride.id, false);
    elevation = better(elevation, ride.elevationGainM, ride.id, false);
    const cum = ride.cumDistanceM;
    if (!cum) continue;
    bestEffortDistances.forEach((d, k) => {
      distanceRecords[k] = better(distanceRecords[k], fastestDistance(cum, d.distanceM), ride.id, true);
    });
  }
  return {
    longestRideM: longest,
    biggestClimbM: climb,
    mostElevationM: elevation,
    distances: bestEffortDistances.map((d, k) => ({ ...d, record: distanceRecords[k] })),
  };
}
