/**
 * Test helpers for the ride tools (AI-654): A's `buildRideFixtures()` with every activity id
 * replaced by a UUID. `get_activity` rejects a non-UUID id (`invalidIdError`), and the fixture
 * ids are names like `ride-outdoor-1`, so the tests run on a copy whose activity ids, paired ids
 * and stream `activityId`s are mapped to stable UUIDs.
 */
import { createMockDataLayer } from "../../data/mock.js";
import { buildRideFixtures, RIDE_FIXTURE_IDS, type RideFixtures } from "../../rides/testing/fixtures.js";
import type { RideReads } from "./reads.js";

/** A pinned instant: Wednesday 2026-11-11, 18:00 UTC. */
export const FIXTURE_NOW = new Date("2026-11-11T18:00:00.000Z");

export type FixtureIdName = keyof typeof RIDE_FIXTURE_IDS;

export interface UuidRideFixtures {
  fixtures: RideFixtures;
  /** `RIDE_FIXTURE_IDS`, mapped to the UUIDs used in `fixtures`. */
  ids: Record<FixtureIdName, string>;
  /** The UUID that replaced a fixture activity id. */
  uuidOf(fixtureId: string): string;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** `buildRideFixtures(now)` with activity ids (and every reference to them) mapped to UUIDs. */
export function buildUuidRideFixtures(now: Date = FIXTURE_NOW, edit?: (f: RideFixtures) => void): UuidRideFixtures {
  const raw = buildRideFixtures(now);
  edit?.(raw);
  const map = new Map(raw.activities.map((a, i) => [a.id, uuid(i + 1)]));
  const uuidOf = (id: string) => {
    const u = map.get(id);
    if (!u) throw new Error(`no fixture activity ${id}`);
    return u;
  };
  const fixtures: RideFixtures = {
    ...raw,
    activities: raw.activities.map((a) => ({
      ...a,
      id: uuidOf(a.id),
      pairedActivityId: a.pairedActivityId === null ? null : uuidOf(a.pairedActivityId),
    })),
    streams: raw.streams.map((s) => ({ ...s, activityId: uuidOf(s.activityId) })),
  };
  const ids = Object.fromEntries(
    Object.entries(RIDE_FIXTURE_IDS).map(([k, v]) => [k, uuidOf(v)]),
  ) as Record<FixtureIdName, string>;
  return { fixtures, ids, uuidOf };
}

/** The mock DataLayer (same filter and order semantics as the backends) over `fixtures`, as RideReads. */
export function fixtureReads(fixtures: RideFixtures): RideReads {
  return createMockDataLayer({ seed: false, rides: fixtures });
}

/** Reads of an account with nothing stored: what Starkeep's DataLayer answers today. */
export const EMPTY_READS: RideReads = {
  listExternalActivities: async () => [],
  getExternalActivity: async () => null,
  getActivityStreams: async () => [],
  listBodyWeights: async () => [],
  getAthleteSettings: async () => ({
    manualFtpW: null,
    lthrBpm: null,
    maxHrBpm: null,
    restingHrBpm: null,
    strengthSessionTss: 50,
    noPowerTssPerHour: 55,
    units: "imperial",
    weekStart: "monday",
  }),
  listFtpHistory: async () => [],
  listDailyTrainingLoad: async () => [],
  listSyncState: async () => [],
};
