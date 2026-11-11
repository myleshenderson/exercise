/**
 * Synthetic ride data for tests, the mock backend (`VITE_MOCK_RIDES=1`) and screenshots (AI-649).
 * No real data: every value comes from a seeded generator. Dates are relative to `now`, so the
 * screenshot mock never ages out of the 12-week windows; unit tests pass a fixed instant.
 */
import { createMockDataLayer } from "../../data/mock";
import type { DataLayer } from "../../data/DataLayer";
import {
  bestEffortDistances,
  biggestClimbM,
  dailyLoad,
  elevationGainM,
  fastestDistance,
  localDate,
  meanMaxPower,
  normalizedPower,
  smoothAltitude,
  tssFromPower,
  workKj,
  type LoadItem,
} from "../../metrics";
import type {
  ActivityStream,
  AthleteSettings,
  BodyWeight,
  DailyTrainingLoad,
  ExternalActivity,
  FtpHistoryEntry,
  SyncState,
} from "../../types";

export interface RideFixtures {
  activities: ExternalActivity[];
  streams: ActivityStream[];
  bodyWeights: BodyWeight[];
  settings: AthleteSettings;
  ftpHistory: FtpHistoryEntry[];
  dailyLoad: DailyTrainingLoad[];
  syncState: SyncState[];
}

/** Ids the screens, tests and screenshots rely on. */
export const RIDE_FIXTURE_IDS = {
  /** Newest outdoor Garmin ride with power; has altitude, power, heart_rate and distance streams. */
  outdoor: "ride-outdoor-1",
  /** Newest Peloton ride; paired with `pairedGarmin`; has power, cadence, heart_rate and resistance streams. */
  indoor: "ride-indoor-1",
  /** The Garmin indoor recording of `indoor` (hidden by visibleActivities). */
  pairedGarmin: "ride-garmin-indoor-1",
  /** A 40 s Garmin fragment (hidden by visibleActivities). */
  fragment: "ride-fragment-1",
  /** An outdoor Garmin ride without power: estimated TSS (decision 16). */
  estimated: "ride-outdoor-estimated-1",
} as const;

export const FIXTURE_TIMEZONE = "America/New_York";
export const FIXTURE_FTP_W = 250;
const WEEKS = 16;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const POWER_CURVE_DURATIONS_S = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400, 7200];

/** Deterministic PRNG (mulberry32) so fixtures are identical on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (v: number, digits = 0) => Number(v.toFixed(digits));

/** A modelled power curve: FTP × (0.95 + sprint and anaerobic terms), × a per-ride factor. */
function modelPowerCurve(ftp: number, durationS: number, factor: number): Record<string, number> {
  const curve: Record<string, number> = {};
  for (const d of POWER_CURVE_DURATIONS_S) {
    if (d > durationS) continue;
    curve[String(d)] = round(ftp * factor * (0.95 + 1.4 * Math.exp(-d / 30) + 0.35 * Math.exp(-d / 600)), 1);
  }
  return curve;
}

function modelBestEfforts(distanceM: number, avgSpeedMps: number) {
  return bestEffortDistances
    .filter((d) => d.distanceM <= distanceM)
    .map((d) => ({ label: d.label, distanceM: d.distanceM, seconds: round(d.distanceM / (avgSpeedMps * (1 + 0.08 * Math.exp(-d.distanceM / 20000))), 1) }));
}

function base(id: string, over: Partial<ExternalActivity> & Pick<ExternalActivity, "source" | "startedAt" | "environment">, syncedAt: string): ExternalActivity {
  return {
    id,
    sourceId: id.replace(/^ride-/, "src-"),
    timezone: FIXTURE_TIMEZONE,
    sport: "cycling",
    subType: null,
    title: null,
    elapsedS: null,
    movingS: null,
    distanceM: null,
    elevationGainM: null,
    avgSpeedMps: null,
    maxSpeedMps: null,
    avgPowerW: null,
    maxPowerW: null,
    normalizedPowerW: null,
    intensityFactor: null,
    tss: null,
    workKj: null,
    calories: null,
    avgHrBpm: null,
    maxHrBpm: null,
    avgCadenceRpm: null,
    biggestClimbM: null,
    tssSource: null,
    ftpUsedW: null,
    ftpSource: null,
    hasPower: false,
    hasHr: false,
    powerCurve: null,
    bestEfforts: null,
    pairedActivityId: null,
    syncedAt,
    ...over,
  };
}

const mean = (xs: readonly (number | null)[]) => {
  const v = xs.filter((x): x is number => typeof x === "number");
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};
const max = (xs: readonly (number | null)[]) => {
  const v = xs.filter((x): x is number => typeof x === "number");
  return v.length ? Math.max(...v) : null;
};

/** The streamed outdoor ride: 2 h of rolling terrain with intervals. */
function outdoorStreams(rand: () => number) {
  const n = 2 * 3600;
  const altitude: number[] = [];
  const power: number[] = [];
  const hr: number[] = [];
  const distance: number[] = [];
  let dist = 0;
  let heart = 95;
  for (let t = 0; t < n; t++) {
    const alt = 120 + 60 * Math.sin(t / 900) + 25 * Math.sin(t / 211) + (t > 4000 && t < 4800 ? (t - 4000) * 0.12 : t >= 4800 ? 96 : 0);
    altitude.push(round(alt, 1));
    const grade = t > 0 ? alt - altitude[t - 1] : 0;
    const interval = t % 1200 > 900 && t > 1200 && t < 6000;
    const target = interval ? 300 : 180 + grade * 120;
    const w = Math.max(0, round(target + (rand() - 0.5) * 60));
    power.push(t > 7000 ? round(w * 0.5) : w);
    heart += ((95 + (power[t] / FIXTURE_FTP_W) * 70) - heart) * 0.02;
    hr.push(round(heart));
    const speed = Math.max(3, 8.5 - grade * 3 + (rand() - 0.5));
    dist += speed;
    distance.push(round(dist, 1));
  }
  return { altitude, power, hr, distance };
}

/** The streamed Peloton class: 45 min, warm-up, three blocks, cool-down. */
function indoorStreams(rand: () => number) {
  const n = 45 * 60;
  const power: number[] = [];
  const cadence: number[] = [];
  const hr: number[] = [];
  const resistance: number[] = [];
  let heart = 90;
  for (let t = 0; t < n; t++) {
    const block = t < 300 ? 0.55 : t > n - 300 ? 0.5 : Math.floor((t - 300) / 420) % 2 === 0 ? 0.95 : 0.7;
    const w = round(FIXTURE_FTP_W * block + (rand() - 0.5) * 30);
    power.push(w);
    cadence.push(round(80 + block * 15 + (rand() - 0.5) * 6));
    resistance.push(round(30 + block * 25 + (rand() - 0.5) * 2));
    heart += ((95 + (w / FIXTURE_FTP_W) * 70) - heart) * 0.03;
    hr.push(round(heart));
  }
  return { power, cadence, hr, resistance };
}

/** The ride fixtures, dated relative to `now`. */
export function buildRideFixtures(now: Date = new Date()): RideFixtures {
  const nowMs = now.getTime();
  const syncedAt = new Date(nowMs - HOUR_MS).toISOString();
  const rand = rng(649);
  const activities: ExternalActivity[] = [];
  const streams: ActivityStream[] = [];
  // Rides start `daysAgo` days before now, two hours earlier in the day, so day 0 is in the past.
  const at = (daysAgo: number, hoursEarlier = 2) => new Date(nowMs - daysAgo * DAY_MS - hoursEarlier * HOUR_MS).toISOString();

  // --- The streamed outdoor ride (today) ---------------------------------------------------
  {
    const s = outdoorStreams(rand);
    const smoothed = smoothAltitude(s.altitude);
    const np = normalizedPower(s.power);
    const movingS = s.power.length;
    const distanceM = s.distance[s.distance.length - 1];
    const curve: Record<string, number> = {};
    for (const [d, w] of Object.entries(meanMaxPower(s.power, POWER_CURVE_DURATIONS_S))) curve[d] = round(w, 1);
    activities.push(
      base(RIDE_FIXTURE_IDS.outdoor, {
        source: "garmin",
        startedAt: at(0, 3),
        environment: "outdoor",
        subType: "road_biking",
        title: "Saturday hills",
        elapsedS: movingS + 540,
        movingS,
        distanceM,
        elevationGainM: round(elevationGainM(smoothed) ?? 0, 1),
        biggestClimbM: round(biggestClimbM(smoothed) ?? 0, 1),
        avgSpeedMps: round(distanceM / movingS, 2),
        maxSpeedMps: 13.4,
        avgPowerW: round(mean(s.power) ?? 0),
        maxPowerW: max(s.power),
        normalizedPowerW: np === null ? null : round(np, 1),
        intensityFactor: np === null ? null : round(np / FIXTURE_FTP_W, 3),
        tss: round(tssFromPower(np, FIXTURE_FTP_W, movingS) ?? 0, 1),
        tssSource: "power",
        ftpUsedW: FIXTURE_FTP_W,
        ftpSource: "manual",
        workKj: round(workKj(s.power) ?? 0, 1),
        calories: round((workKj(s.power) ?? 0) * 1.05),
        avgHrBpm: round(mean(s.hr) ?? 0),
        maxHrBpm: max(s.hr),
        avgCadenceRpm: 86,
        hasPower: true,
        hasHr: true,
        powerCurve: curve,
        bestEfforts: bestEffortDistances.flatMap((d) => {
          const seconds = fastestDistance(s.distance, d.distanceM);
          return seconds === null ? [] : [{ label: d.label, distanceM: d.distanceM, seconds: round(seconds, 1) }];
        }),
      }, syncedAt),
    );
    streams.push(
      { activityId: RIDE_FIXTURE_IDS.outdoor, channel: "altitude", startOffsetS: 0, values: s.altitude },
      { activityId: RIDE_FIXTURE_IDS.outdoor, channel: "distance", startOffsetS: 0, values: s.distance },
      { activityId: RIDE_FIXTURE_IDS.outdoor, channel: "heart_rate", startOffsetS: 0, values: s.hr },
      { activityId: RIDE_FIXTURE_IDS.outdoor, channel: "power", startOffsetS: 0, values: s.power },
    );
  }

  // --- The streamed Peloton ride (yesterday), paired with a Garmin indoor recording ---------
  {
    const s = indoorStreams(rand);
    const np = normalizedPower(s.power);
    const movingS = s.power.length;
    const startedAt = at(1, 1);
    const curve: Record<string, number> = {};
    for (const [d, w] of Object.entries(meanMaxPower(s.power, POWER_CURVE_DURATIONS_S))) curve[d] = round(w, 1);
    activities.push(
      base(RIDE_FIXTURE_IDS.indoor, {
        source: "peloton",
        startedAt,
        environment: "indoor",
        subType: "cycling",
        title: "45 min Power Zone Ride",
        elapsedS: movingS,
        movingS,
        distanceM: 21500,
        avgSpeedMps: round(21500 / movingS, 2),
        avgPowerW: round(mean(s.power) ?? 0),
        maxPowerW: max(s.power),
        normalizedPowerW: np === null ? null : round(np, 1),
        intensityFactor: np === null ? null : round(np / FIXTURE_FTP_W, 3),
        tss: round(tssFromPower(np, FIXTURE_FTP_W, movingS) ?? 0, 1),
        tssSource: "power",
        ftpUsedW: FIXTURE_FTP_W,
        ftpSource: "manual",
        workKj: round(workKj(s.power) ?? 0, 1),
        calories: 520,
        avgHrBpm: round(mean(s.hr) ?? 0),
        maxHrBpm: max(s.hr),
        avgCadenceRpm: round(mean(s.cadence) ?? 0),
        hasPower: true,
        hasHr: true,
        powerCurve: curve,
        pairedActivityId: RIDE_FIXTURE_IDS.pairedGarmin,
      }, syncedAt),
      base(RIDE_FIXTURE_IDS.pairedGarmin, {
        source: "garmin",
        startedAt: new Date(Date.parse(startedAt) - 120_000).toISOString(),
        environment: "indoor",
        subType: "indoor_cycling",
        title: "Indoor Cycling",
        elapsedS: movingS + 180,
        movingS: movingS + 120,
        tss: round(((movingS + 120) / 3600) * 55, 1),
        tssSource: "estimated_flat",
        pairedActivityId: RIDE_FIXTURE_IDS.indoor,
      }, syncedAt),
    );
    streams.push(
      { activityId: RIDE_FIXTURE_IDS.indoor, channel: "cadence", startOffsetS: 0, values: s.cadence },
      { activityId: RIDE_FIXTURE_IDS.indoor, channel: "heart_rate", startOffsetS: 0, values: s.hr },
      { activityId: RIDE_FIXTURE_IDS.indoor, channel: "power", startOffsetS: 0, values: s.power },
      { activityId: RIDE_FIXTURE_IDS.indoor, channel: "resistance", startOffsetS: 0, values: s.resistance },
    );
  }

  // --- A 40 s fragment (today) and an estimated-TSS outdoor ride (3 days ago) ---------------
  activities.push(
    base(RIDE_FIXTURE_IDS.fragment, {
      source: "garmin",
      startedAt: at(0, 1),
      environment: "outdoor",
      subType: "road_biking",
      title: "Road Cycling",
      elapsedS: 40,
      movingS: 35,
      distanceM: 120,
      tss: 0.5,
      tssSource: "estimated_flat",
    }, syncedAt),
    base(RIDE_FIXTURE_IDS.estimated, {
      source: "garmin",
      startedAt: at(3),
      environment: "outdoor",
      subType: "road_biking",
      title: "Coffee ride",
      elapsedS: 6300,
      movingS: 5700,
      distanceM: 41800,
      elevationGainM: 310,
      biggestClimbM: 64,
      avgSpeedMps: round(41800 / 5700, 2),
      maxSpeedMps: 12.1,
      calories: 1150,
      tss: round((5700 / 3600) * 55, 1),
      tssSource: "estimated_flat",
      bestEfforts: modelBestEfforts(41800, 41800 / 5700),
    }, syncedAt),
  );

  // --- 16 weeks of history: an outdoor ride with power, one without, and two Peloton rides a week
  let outdoorN = 2;
  let indoorN = 2;
  for (let week = 0; week < WEEKS; week++) {
    const offsets = week === 0 ? [5] : [week * 7 + 1, week * 7 + 3, week * 7 + 4, week * 7 + 6];
    for (const daysAgo of offsets) {
      const kind = (daysAgo + week) % 4;
      if (kind === 0 || kind === 1) {
        const hasPower = kind === 0;
        const movingS = round(3600 * (1.2 + rand() * 3.3));
        const speed = 7 + rand() * 1.6;
        const distanceM = round(movingS * speed, 1);
        const factor = 0.85 + rand() * 0.17;
        const curve = hasPower ? modelPowerCurve(FIXTURE_FTP_W, movingS, factor) : null;
        const np = hasPower ? round(FIXTURE_FTP_W * (0.68 + rand() * 0.14), 1) : null;
        const tss = hasPower ? round((movingS / 3600) * (np! / FIXTURE_FTP_W) ** 2 * 100, 1) : round((movingS / 3600) * 55, 1);
        activities.push(
          base(`ride-outdoor-${outdoorN++}`, {
            source: "garmin",
            startedAt: at(daysAgo, 2 + (daysAgo % 3)),
            environment: "outdoor",
            subType: "road_biking",
            title: movingS > 3 * 3600 ? "Long ride" : "Road Cycling",
            elapsedS: movingS + round(rand() * 900),
            movingS,
            distanceM,
            elevationGainM: round(distanceM * (0.006 + rand() * 0.012), 1),
            biggestClimbM: round(30 + rand() * 180, 1),
            avgSpeedMps: round(speed, 2),
            maxSpeedMps: round(speed * 1.7, 2),
            avgPowerW: np === null ? null : round(np * 0.92),
            maxPowerW: curve ? curve["1"] ?? null : null,
            normalizedPowerW: np,
            intensityFactor: np === null ? null : round(np / FIXTURE_FTP_W, 3),
            tss,
            tssSource: hasPower ? "power" : "estimated_flat",
            ftpUsedW: hasPower ? FIXTURE_FTP_W : null,
            ftpSource: hasPower ? "manual" : null,
            workKj: np === null ? null : round((np * 0.92 * movingS) / 1000, 1),
            calories: round(movingS * 0.2),
            hasPower,
            powerCurve: curve,
            bestEfforts: modelBestEfforts(distanceM, speed),
          }, syncedAt),
        );
      } else {
        const movingS = [1200, 1800, 2700, 3600][Math.floor(rand() * 4)];
        const np = round(FIXTURE_FTP_W * (0.7 + rand() * 0.2), 1);
        const curve = modelPowerCurve(FIXTURE_FTP_W, movingS, 0.88 + rand() * 0.12);
        activities.push(
          base(`ride-indoor-${indoorN++}`, {
            source: "peloton",
            startedAt: at(daysAgo, 12),
            environment: "indoor",
            subType: "cycling",
            title: `${movingS / 60} min ${kind === 2 ? "Endurance" : "HIIT & Hills"} Ride`,
            elapsedS: movingS,
            movingS,
            distanceM: round(movingS * (7.5 + rand()), 1),
            avgPowerW: round(np * 0.93),
            maxPowerW: curve["1"] ?? null,
            normalizedPowerW: np,
            intensityFactor: round(np / FIXTURE_FTP_W, 3),
            tss: round((movingS / 3600) * (np / FIXTURE_FTP_W) ** 2 * 100, 1),
            tssSource: "power",
            ftpUsedW: FIXTURE_FTP_W,
            ftpSource: "manual",
            workKj: round((np * 0.93 * movingS) / 1000, 1),
            calories: round(movingS * 0.19),
            avgHrBpm: round(130 + rand() * 20),
            maxHrBpm: round(160 + rand() * 15),
            avgCadenceRpm: round(82 + rand() * 10),
            hasPower: true,
            hasHr: true,
            powerCurve: curve,
          }, syncedAt),
        );
      }
    }
  }
  activities.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

  // --- Body weight: 120 days, most mornings, drifting from ~81.5 kg to ~79.8 kg ----------------
  const bodyWeights: BodyWeight[] = [];
  for (let d = 119; d >= 0; d--) {
    if (d % 7 === 3 && d > 0) continue; // a missed day a week
    const kg = round(79.8 + (1.7 * d) / 119 + (rand() - 0.5) * 0.9, 2);
    bodyWeights.push({
      id: `bw-${120 - d}`,
      source: "garmin",
      sourceId: `weight-${120 - d}`,
      measuredAt: new Date(nowMs - d * DAY_MS - 2.5 * HOUR_MS).toISOString(),
      weightKg: kg,
      bmi: round(kg / 1.8 ** 2, 1),
      bodyFatPct: round(17 + (rand() - 0.5), 1),
      bodyWaterPct: null,
      muscleMassKg: null,
      boneMassKg: null,
    });
  }

  const settings: AthleteSettings = {
    manualFtpW: FIXTURE_FTP_W,
    lthrBpm: 168,
    maxHrBpm: 186,
    restingHrBpm: 52,
    strengthSessionTss: 50,
    noPowerTssPerHour: 55,
    units: "imperial",
    weekStart: "monday",
  };

  const ftpHistory: FtpHistoryEntry[] = [
    { id: "ftp-1", effectiveFrom: new Date(nowMs - 150 * DAY_MS).toISOString(), ftpW: 232, source: "peloton_test", sourceRef: "src-ftp-test-1" },
    { id: "ftp-2", effectiveFrom: new Date(nowMs - 70 * DAY_MS).toISOString(), ftpW: 244, source: "peloton_test", sourceRef: "src-ftp-test-2" },
    { id: "ftp-3", effectiveFrom: new Date(nowMs - 10 * DAY_MS).toISOString(), ftpW: FIXTURE_FTP_W, source: "manual", sourceRef: null },
  ];

  // --- Daily training load from the activities, through src/metrics -------------------------
  const items: LoadItem[] = activities.flatMap((a) =>
    a.tss === null || a.tssSource === null
      ? []
      : [{ id: a.id, startedAt: a.startedAt, timezone: a.timezone ?? "UTC", source: a.source, tss: a.tss, tssSource: a.tssSource, pairedActivityId: a.pairedActivityId }],
  );
  const today = localDate(now.toISOString(), FIXTURE_TIMEZONE)!;
  const first = localDate(new Date(nowMs - WEEKS * 7 * DAY_MS).toISOString(), FIXTURE_TIMEZONE)!;
  const load: DailyTrainingLoad[] = dailyLoad(items, first, today, { ctl: 42, atl: 45 }).map((r) => ({
    date: r.date,
    tssTotal: round(r.tssTotal, 1),
    tssBySource: r.tssBySource,
    ctl: round(r.ctl, 2),
    atl: round(r.atl, 2),
    tsb: round(r.tsb, 2),
  }));

  const iso = (msAgo: number) => new Date(nowMs - msAgo).toISOString();
  const syncState: SyncState[] = [
    {
      source: "garmin_activities",
      cursor: { lastStart: iso(3 * HOUR_MS) },
      lastRunAt: iso(HOUR_MS),
      lastSuccessAt: iso(HOUR_MS),
      itemsFetched: 4,
      itemsUpserted: 4,
      lastError: null,
      backfillComplete: true,
      authStatus: "ok",
    },
    {
      source: "garmin_weight",
      cursor: { year: now.getUTCFullYear() },
      lastRunAt: iso(HOUR_MS),
      lastSuccessAt: iso(HOUR_MS),
      itemsFetched: 1,
      itemsUpserted: 1,
      lastError: null,
      backfillComplete: true,
      authStatus: "ok",
    },
    {
      source: "peloton",
      cursor: { newestWorkoutId: "src-indoor-1" },
      lastRunAt: iso(HOUR_MS),
      lastSuccessAt: iso(26 * HOUR_MS),
      itemsFetched: 0,
      itemsUpserted: 0,
      lastError: "Peloton refresh token was rejected (invalid_grant)",
      backfillComplete: true,
      authStatus: "reconnect_required",
    },
  ];

  return { activities, streams, bodyWeights, settings, ftpHistory, dailyLoad: load, syncState };
}

/** A mock DataLayer (with the usual strength seed) preloaded with `buildRideFixtures(now)`. */
export function createRideFixtureDb(now: Date = new Date()): DataLayer {
  return createMockDataLayer({ rides: buildRideFixtures(now) });
}
