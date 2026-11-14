/**
 * Ride analytics rows on Starkeep (epic AI-822): the row shapes of the eight
 * ride tables, their deterministic ids, and the mappers between them and the
 * app types. The Starkeep DataLayer (`./rideAnalytics.ts`) and the wave 2 sync
 * store share these, so the id scheme and the JSON encoding live in one place.
 *
 * Decision 1, deterministic ids: the row API upserts on the primary key, so
 * each Postgres unique constraint becomes the id.
 * - `external_activities.id = <source>:<source_id>`
 * - `body_weights.id = <source>:<source_id>`
 * - `activity_streams.id = <activity_id>:<channel>`
 * - `ftp_history.id = <effective_from>|<source>` (effective_from as canonical ISO)
 * - `daily_training_load.id = <date>` (`YYYY-MM-DD`)
 * - `sync_state.id = <source>`
 * - `athlete_settings.id = "settings"` (one row per user; the platform scopes rows)
 *
 * Decision 2, JSON in text: `provider_payload`, `power_curve`, `best_efforts`,
 * `tss_by_source`, `cursor` and `activity_streams.values` are JSON strings,
 * written with `JSON.stringify` and parsed on read. A cell that does not parse
 * throws {@link RideRowJsonError}, naming the table, the row id and the column.
 *
 * Timestamps are written as canonical `toISOString()` text (the column type is
 * `timestamp`), so they compare correctly as strings. `updated_at` is reserved
 * by Starkeep and never written; `created_at` is the app's own column.
 */
import type {
  ActivitySource,
  ActivityStream,
  ActivityStreamInput,
  AthleteSettings,
  BodyWeight,
  BodyWeightInput,
  DailyTrainingLoad,
  ExternalActivity,
  ExternalActivityInput,
  FtpHistoryEntry,
  FtpSource,
  StreamChannel,
  SyncSource,
  SyncState,
} from "../../types.js";
import { DEFAULT_ATHLETE_SETTINGS } from "../DataLayer.js";
import { timestampMicros } from "../../analysis/sqlSemantics.js";

export const RIDE_TABLES = {
  activities: "external_activities",
  streams: "activity_streams",
  bodyWeights: "body_weights",
  settings: "athlete_settings",
  ftp: "ftp_history",
  dailyLoad: "daily_training_load",
  syncState: "sync_state",
} as const;

/** `athlete_settings.id`: the user's single settings row. */
export const ATHLETE_SETTINGS_ID = "settings";

// ---- row shapes ------------------------------------------------------------------

export interface ExternalActivityRow {
  [key: string]: unknown;
  id: string;
  source: string;
  source_id: string;
  started_at: string;
  timezone: string | null;
  sport: string;
  sub_type: string | null;
  environment: string;
  title: string | null;
  elapsed_s: number | null;
  moving_s: number | null;
  distance_m: number | null;
  elevation_gain_m: number | null;
  avg_speed_mps: number | null;
  max_speed_mps: number | null;
  avg_power_w: number | null;
  max_power_w: number | null;
  normalized_power_w: number | null;
  intensity_factor: number | null;
  tss: number | null;
  work_kj: number | null;
  calories: number | null;
  avg_hr_bpm: number | null;
  max_hr_bpm: number | null;
  avg_cadence_rpm: number | null;
  biggest_climb_m: number | null;
  tss_source: string | null;
  ftp_used_w: number | null;
  ftp_source: string | null;
  has_power: boolean;
  has_hr: boolean;
  power_curve: string | null;
  best_efforts: string | null;
  paired_activity_id: string | null;
  /** Absent on reads, which never select it. */
  provider_payload?: string;
  synced_at: string;
  created_at?: string;
}

export interface ActivityStreamRow {
  [key: string]: unknown;
  id: string;
  activity_id: string;
  channel: string;
  start_offset_s: number;
  values: string;
  created_at?: string;
}

export interface BodyWeightRow {
  [key: string]: unknown;
  id: string;
  source: string;
  source_id: string;
  measured_at: string;
  weight_kg: number;
  bmi: number | null;
  body_fat_pct: number | null;
  body_water_pct: number | null;
  muscle_mass_kg: number | null;
  bone_mass_kg: number | null;
  /** Absent on reads, which never select it. */
  provider_payload?: string;
  created_at?: string;
}

export interface AthleteSettingsRow {
  [key: string]: unknown;
  id: string;
  manual_ftp_w: number | null;
  lthr_bpm: number | null;
  max_hr_bpm: number | null;
  resting_hr_bpm: number | null;
  strength_session_tss: number;
  no_power_tss_per_hour: number;
  units: string;
  week_start: string;
  created_at?: string;
}

export interface FtpHistoryRow {
  [key: string]: unknown;
  id: string;
  effective_from: string;
  ftp_w: number;
  source: string;
  source_ref: string | null;
  created_at?: string;
}

export interface DailyTrainingLoadRow {
  [key: string]: unknown;
  id: string;
  date: string;
  tss_total: number;
  tss_by_source: string;
  ctl: number;
  atl: number;
  tsb: number;
  created_at?: string;
}

export interface SyncStateRow {
  [key: string]: unknown;
  id: string;
  source: string;
  cursor: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  items_fetched: number;
  items_upserted: number;
  last_error: string | null;
  backfill_complete: boolean;
  auth_status: string;
  created_at?: string;
}

// ---- columns read back (never provider_payload) -------------------------------------

export const EXTERNAL_ACTIVITY_READ_COLUMNS = [
  "id", "source", "source_id", "started_at", "timezone", "sport", "sub_type", "environment", "title",
  "elapsed_s", "moving_s", "distance_m", "elevation_gain_m", "avg_speed_mps", "max_speed_mps",
  "avg_power_w", "max_power_w", "normalized_power_w", "intensity_factor", "tss", "work_kj", "calories",
  "avg_hr_bpm", "max_hr_bpm", "avg_cadence_rpm", "biggest_climb_m", "tss_source", "ftp_used_w", "ftp_source",
  "has_power", "has_hr", "power_curve", "best_efforts", "paired_activity_id", "synced_at",
];

export const BODY_WEIGHT_READ_COLUMNS = [
  "id", "source", "source_id", "measured_at", "weight_kg", "bmi", "body_fat_pct", "body_water_pct",
  "muscle_mass_kg", "bone_mass_kg",
];

// ---- ids --------------------------------------------------------------------------

export const externalActivityId = (source: string, sourceId: string): string => `${source}:${sourceId}`;
export const bodyWeightId = (source: string, sourceId: string): string => `${source}:${sourceId}`;
export const activityStreamId = (activityId: string, channel: string): string => `${activityId}:${channel}`;
/** `effectiveFrom` is normalised to canonical ISO first, so one instant has one id. */
export const ftpHistoryId = (effectiveFrom: string, source: string): string =>
  `${isoInstant(effectiveFrom, `${RIDE_TABLES.ftp}.effective_from`)}|${source}`;
export const dailyTrainingLoadId = (date: string): string => calendarDate(date, `${RIDE_TABLES.dailyLoad}.date`);
export const syncStateId = (source: string): string => source;

// ---- value helpers ------------------------------------------------------------------

/** Thrown when a JSON-in-text cell does not parse. */
export class RideRowJsonError extends Error {
  readonly table: string;
  readonly rowId: string;
  readonly column: string;
  constructor(table: string, rowId: string, column: string, cause: unknown) {
    super(
      `Starkeep ${table} row ${JSON.stringify(rowId)}: column ${column} is not valid JSON (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    );
    this.name = "RideRowJsonError";
    this.table = table;
    this.rowId = rowId;
    this.column = column;
  }
}

/** Parse a JSON-in-text cell; null/undefined (an unset column) is `null`. */
export function parseJsonCell(table: string, row: { id?: unknown }, column: string, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new RideRowJsonError(table, String(row.id), column, new Error(`got ${typeof raw}, not text`));
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new RideRowJsonError(table, String(row.id), column, err);
  }
}

/** JSON text for a nullable JSON column: null/undefined stay null. */
const jsonOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));

/**
 * Canonical `toISOString()` text for an instant (the `timestamp` column form,
 * and what makes string comparison order by time). Accepts what Postgres's
 * `timestamptz` input does (`timestampMicros`: ISO 8601, `2026-11-01 10:00:00+00`,
 * no offset meaning UTC); throws a RangeError on anything else. Stored values
 * have millisecond precision, so sub-millisecond input is truncated, or rounded
 * up with `round: "up"` (a lower bound: `>= x.0005` matches what `>= x.001` does).
 */
export function isoInstant(value: string, what: string, round: "down" | "up" = "down"): string {
  let micros: bigint;
  try {
    micros = timestampMicros(value);
  } catch {
    throw new RangeError(`${what} must be an ISO 8601 instant, got ${JSON.stringify(value)}`);
  }
  let ms = micros / 1000n;
  if (micros - ms * 1000n < 0n) ms -= 1n; // floor, also before 1970
  if (round === "up" && ms * 1000n < micros) ms += 1n;
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) throw new RangeError(`${what} is out of range, got ${JSON.stringify(value)}`);
  return date.toISOString();
}

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/**
 * The `YYYY-MM-DD` calendar date of a `date` value. Like Postgres's cast to
 * `date`, a longer value starting with a date (`2026-11-01T…`) keeps just the date.
 */
export function calendarDate(value: string, what: string): string {
  const m = DATE_PREFIX.exec(value);
  // Round-trip through Date: V8 parses 2026-02-30 (rolling it into March); Postgres refuses it.
  const ms = m ? Date.parse(`${m[0]}T00:00:00.000Z`) : NaN;
  if (!m || Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== m[0]) {
    throw new RangeError(`${what} must be a date (YYYY-MM-DD), got ${JSON.stringify(value)}`);
  }
  return m[0];
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const nullable = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
const str = (v: unknown): string | null => (v === null || v === undefined ? null : (v as string));

// ---- external_activities --------------------------------------------------------------

// [camelCase field, snake_case column] for every nullable real activity column (supabase.ts's list).
const ACTIVITY_METRICS: [keyof ExternalActivity & keyof ExternalActivityInput, string][] = [
  ["elapsedS", "elapsed_s"], ["movingS", "moving_s"], ["distanceM", "distance_m"],
  ["elevationGainM", "elevation_gain_m"], ["avgSpeedMps", "avg_speed_mps"], ["maxSpeedMps", "max_speed_mps"],
  ["avgPowerW", "avg_power_w"], ["maxPowerW", "max_power_w"], ["normalizedPowerW", "normalized_power_w"],
  ["intensityFactor", "intensity_factor"], ["tss", "tss"], ["workKj", "work_kj"], ["calories", "calories"],
  ["avgHrBpm", "avg_hr_bpm"], ["maxHrBpm", "max_hr_bpm"], ["avgCadenceRpm", "avg_cadence_rpm"],
  ["biggestClimbM", "biggest_climb_m"],
];

/** Every write supplies these: `now` stamps synced_at (when absent) and created_at (for a new row). */
export interface RowWriteContext {
  now: string;
  /** The existing row's created_at, kept on an upsert of a row that already exists. */
  createdAt?: string | null;
}

/**
 * The full row for an upsert. Omitted optional fields become null/false, as the
 * Supabase upsert writes them. `syncedAt` is the input's when it carries one
 * (the sync store may), else `now`. Throws when providerPayload is missing.
 */
export function toExternalActivityRow(
  a: ExternalActivityInput & { syncedAt?: string },
  ctx: RowWriteContext,
): ExternalActivityRow & { provider_payload: string; created_at: string } {
  if (a.providerPayload === undefined || a.providerPayload === null) {
    throw new Error(`external activity ${a.source}/${a.sourceId} has no providerPayload; it is required (provider_payload is not null)`);
  }
  const row = {
    id: externalActivityId(a.source, a.sourceId),
    source: a.source,
    source_id: a.sourceId,
    started_at: isoInstant(a.startedAt, `${RIDE_TABLES.activities}.started_at`),
    timezone: nullable(a.timezone),
    sport: a.sport,
    sub_type: nullable(a.subType),
    environment: a.environment,
    title: nullable(a.title),
    tss_source: nullable(a.tssSource),
    // ftp_used_w is an integer column: whole watts.
    ftp_used_w: a.ftpUsedW === null || a.ftpUsedW === undefined ? null : Math.round(a.ftpUsedW),
    ftp_source: nullable(a.ftpSource),
    has_power: a.hasPower ?? false,
    has_hr: a.hasHr ?? false,
    power_curve: jsonOrNull(a.powerCurve),
    best_efforts: jsonOrNull(a.bestEfforts),
    paired_activity_id: nullable(a.pairedActivityId),
    provider_payload: JSON.stringify(a.providerPayload),
    synced_at: a.syncedAt === undefined ? ctx.now : isoInstant(a.syncedAt, `${RIDE_TABLES.activities}.synced_at`),
    created_at: ctx.createdAt ?? ctx.now,
  } as ExternalActivityRow & { provider_payload: string; created_at: string };
  for (const [field, column] of ACTIVITY_METRICS) row[column] = nullable(a[field] as number | null | undefined);
  return row;
}

/** The app type; provider_payload is never part of it (reads do not select it). */
export function fromExternalActivityRow(r: ExternalActivityRow): ExternalActivity {
  const t = RIDE_TABLES.activities;
  return {
    id: r.id,
    source: r.source as ActivitySource,
    sourceId: r.source_id,
    startedAt: r.started_at,
    timezone: str(r.timezone),
    sport: r.sport,
    subType: str(r.sub_type),
    environment: r.environment as ExternalActivity["environment"],
    title: str(r.title),
    elapsedS: num(r.elapsed_s),
    movingS: num(r.moving_s),
    distanceM: num(r.distance_m),
    elevationGainM: num(r.elevation_gain_m),
    avgSpeedMps: num(r.avg_speed_mps),
    maxSpeedMps: num(r.max_speed_mps),
    avgPowerW: num(r.avg_power_w),
    maxPowerW: num(r.max_power_w),
    normalizedPowerW: num(r.normalized_power_w),
    intensityFactor: num(r.intensity_factor),
    tss: num(r.tss),
    workKj: num(r.work_kj),
    calories: num(r.calories),
    avgHrBpm: num(r.avg_hr_bpm),
    maxHrBpm: num(r.max_hr_bpm),
    avgCadenceRpm: num(r.avg_cadence_rpm),
    biggestClimbM: num(r.biggest_climb_m),
    tssSource: (r.tss_source as ExternalActivity["tssSource"]) ?? null,
    ftpUsedW: num(r.ftp_used_w),
    ftpSource: str(r.ftp_source),
    hasPower: r.has_power === true,
    hasHr: r.has_hr === true,
    powerCurve: parseJsonCell(t, r, "power_curve", r.power_curve),
    bestEfforts: parseJsonCell(t, r, "best_efforts", r.best_efforts),
    pairedActivityId: str(r.paired_activity_id),
    syncedAt: r.synced_at,
  };
}

/** The stored provider payload of a full row (reads never return it; the sync store may want it). */
export function externalActivityPayload(r: ExternalActivityRow): unknown {
  return parseJsonCell(RIDE_TABLES.activities, r, "provider_payload", r.provider_payload);
}

// ---- activity_streams -------------------------------------------------------------------

export function toActivityStreamRow(
  activityId: string,
  s: ActivityStreamInput,
  ctx: RowWriteContext,
): ActivityStreamRow & { created_at: string } {
  return {
    id: activityStreamId(activityId, s.channel),
    activity_id: activityId,
    channel: s.channel,
    start_offset_s: s.startOffsetS ?? 0,
    values: JSON.stringify(s.values),
    created_at: ctx.createdAt ?? ctx.now,
  };
}

export function fromActivityStreamRow(r: ActivityStreamRow): ActivityStream {
  const values = parseJsonCell(RIDE_TABLES.streams, r, "values", r.values);
  if (values !== null && !Array.isArray(values)) {
    throw new RideRowJsonError(RIDE_TABLES.streams, r.id, "values", new Error("not a JSON array"));
  }
  return {
    activityId: r.activity_id,
    channel: r.channel as StreamChannel,
    startOffsetS: Number(r.start_offset_s),
    values: (values as (number | null)[] | null) ?? [],
  };
}

// ---- body_weights ---------------------------------------------------------------------

export function toBodyWeightRow(w: BodyWeightInput, ctx: RowWriteContext): BodyWeightRow & { provider_payload: string; created_at: string } {
  if (w.providerPayload === undefined || w.providerPayload === null) {
    throw new Error(`body weight ${w.source}/${w.sourceId} has no providerPayload; it is required (provider_payload is not null)`);
  }
  return {
    id: bodyWeightId(w.source, w.sourceId),
    source: w.source,
    source_id: w.sourceId,
    measured_at: isoInstant(w.measuredAt, `${RIDE_TABLES.bodyWeights}.measured_at`),
    weight_kg: w.weightKg,
    bmi: nullable(w.bmi),
    body_fat_pct: nullable(w.bodyFatPct),
    body_water_pct: nullable(w.bodyWaterPct),
    muscle_mass_kg: nullable(w.muscleMassKg),
    bone_mass_kg: nullable(w.boneMassKg),
    provider_payload: JSON.stringify(w.providerPayload),
    created_at: ctx.createdAt ?? ctx.now,
  };
}

export function fromBodyWeightRow(r: BodyWeightRow): BodyWeight {
  return {
    id: r.id,
    source: r.source as BodyWeight["source"],
    sourceId: r.source_id,
    measuredAt: r.measured_at,
    weightKg: Number(r.weight_kg),
    bmi: num(r.bmi),
    bodyFatPct: num(r.body_fat_pct),
    bodyWaterPct: num(r.body_water_pct),
    muscleMassKg: num(r.muscle_mass_kg),
    boneMassKg: num(r.bone_mass_kg),
  };
}

// ---- athlete_settings -------------------------------------------------------------------

/** [field, column] for every athlete_settings column (supabase.ts's list). */
export const ATHLETE_SETTINGS_FIELDS: [keyof AthleteSettings, string][] = [
  ["manualFtpW", "manual_ftp_w"], ["lthrBpm", "lthr_bpm"], ["maxHrBpm", "max_hr_bpm"],
  ["restingHrBpm", "resting_hr_bpm"], ["strengthSessionTss", "strength_session_tss"],
  ["noPowerTssPerHour", "no_power_tss_per_hour"], ["units", "units"], ["weekStart", "week_start"],
];

const SETTINGS_INTEGER_FIELDS = new Set<keyof AthleteSettings>(["manualFtpW", "lthrBpm", "maxHrBpm", "restingHrBpm"]);
const SETTINGS_ENUMS: Partial<Record<keyof AthleteSettings, readonly string[]>> = {
  units: ["imperial", "metric"],
  weekStart: ["monday", "sunday"],
};

/**
 * The columns for the defined fields of `patch` only (what saveAthleteSettings
 * changes). Throws on a value the Postgres columns refuse: a non-integer in an
 * `integer` column, a units/week_start outside its check constraint, or null
 * in a `not null` column.
 */
export function athleteSettingsPatch(patch: Partial<AthleteSettings>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, column] of ATHLETE_SETTINGS_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    const allowed = SETTINGS_ENUMS[field];
    const bad =
      value === null
        ? !SETTINGS_INTEGER_FIELDS.has(field)
        : allowed
          ? !allowed.includes(value as string)
          : SETTINGS_INTEGER_FIELDS.has(field)
            ? !Number.isInteger(value)
            : typeof value !== "number" || !Number.isFinite(value);
    if (bad) throw new RangeError(`athlete settings ${field} cannot be ${JSON.stringify(value)}`);
    out[column] = value;
  }
  return out;
}

/** The full settings row: `s` over {@link DEFAULT_ATHLETE_SETTINGS} (the column defaults). */
export function toAthleteSettingsRow(s: Partial<AthleteSettings>, ctx: RowWriteContext): AthleteSettingsRow & { created_at: string } {
  return {
    id: ATHLETE_SETTINGS_ID,
    ...athleteSettingsPatch({ ...DEFAULT_ATHLETE_SETTINGS, ...definedOnly(s) }),
    created_at: ctx.createdAt ?? ctx.now,
  } as AthleteSettingsRow & { created_at: string };
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function fromAthleteSettingsRow(r: AthleteSettingsRow): AthleteSettings {
  return {
    manualFtpW: num(r.manual_ftp_w),
    lthrBpm: num(r.lthr_bpm),
    maxHrBpm: num(r.max_hr_bpm),
    restingHrBpm: num(r.resting_hr_bpm),
    strengthSessionTss: Number(r.strength_session_tss),
    noPowerTssPerHour: Number(r.no_power_tss_per_hour),
    units: r.units as AthleteSettings["units"],
    weekStart: r.week_start as AthleteSettings["weekStart"],
  };
}

// ---- ftp_history ----------------------------------------------------------------------

export function toFtpHistoryRow(e: Omit<FtpHistoryEntry, "id">, ctx: RowWriteContext): FtpHistoryRow & { created_at: string } {
  const effectiveFrom = isoInstant(e.effectiveFrom, `${RIDE_TABLES.ftp}.effective_from`);
  return {
    id: ftpHistoryId(effectiveFrom, e.source),
    effective_from: effectiveFrom,
    ftp_w: e.ftpW,
    source: e.source,
    source_ref: e.sourceRef ?? null,
    created_at: ctx.createdAt ?? ctx.now,
  };
}

export function fromFtpHistoryRow(r: FtpHistoryRow): FtpHistoryEntry {
  return {
    id: r.id,
    effectiveFrom: r.effective_from,
    ftpW: Number(r.ftp_w),
    source: r.source as FtpSource,
    sourceRef: str(r.source_ref),
  };
}

// ---- daily_training_load ------------------------------------------------------------------

export function toDailyTrainingLoadRow(d: DailyTrainingLoad, ctx: RowWriteContext): DailyTrainingLoadRow & { created_at: string } {
  const date = dailyTrainingLoadId(d.date);
  return {
    id: date,
    date,
    tss_total: d.tssTotal,
    tss_by_source: JSON.stringify(d.tssBySource ?? {}),
    ctl: d.ctl,
    atl: d.atl,
    tsb: d.tsb,
    created_at: ctx.createdAt ?? ctx.now,
  };
}

export function fromDailyTrainingLoadRow(r: DailyTrainingLoadRow): DailyTrainingLoad {
  return {
    date: r.date,
    tssTotal: Number(r.tss_total),
    tssBySource: (parseJsonCell(RIDE_TABLES.dailyLoad, r, "tss_by_source", r.tss_by_source) as DailyTrainingLoad["tssBySource"]) ?? {},
    ctl: Number(r.ctl),
    atl: Number(r.atl),
    tsb: Number(r.tsb),
  };
}

// ---- sync_state -------------------------------------------------------------------------

/** The full row for one source's state. */
export function toSyncStateRow(s: SyncState, ctx: RowWriteContext): SyncStateRow & { created_at: string } {
  const at = (v: string | null, column: string) => (v === null ? null : isoInstant(v, `${RIDE_TABLES.syncState}.${column}`));
  return {
    id: syncStateId(s.source),
    source: s.source,
    cursor: jsonOrNull(s.cursor),
    last_run_at: at(s.lastRunAt, "last_run_at"),
    last_success_at: at(s.lastSuccessAt, "last_success_at"),
    items_fetched: s.itemsFetched,
    items_upserted: s.itemsUpserted,
    last_error: s.lastError,
    backfill_complete: s.backfillComplete,
    auth_status: s.authStatus,
    created_at: ctx.createdAt ?? ctx.now,
  };
}

export function fromSyncStateRow(r: SyncStateRow): SyncState {
  return {
    source: r.source as SyncSource,
    cursor: parseJsonCell(RIDE_TABLES.syncState, r, "cursor", r.cursor),
    lastRunAt: str(r.last_run_at),
    lastSuccessAt: str(r.last_success_at),
    itemsFetched: Number(r.items_fetched),
    itemsUpserted: Number(r.items_upserted),
    lastError: str(r.last_error),
    backfillComplete: r.backfill_complete === true,
    authStatus: r.auth_status as SyncState["authStatus"],
  };
}
