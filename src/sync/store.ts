// src/data/supabase.ts pulls in supabaseClient.ts (import.meta.env); tsconfig.api.json includes
// this file for that reason, and the reference keeps a standalone nodenext check of src/sync working.
/// <reference path="../vite-env.d.ts" />
/** The storage port of the sync core (AI-637) and its Supabase implementation. Test double: testing/memoryStore.ts. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_ATHLETE_SETTINGS } from "../data/DataLayer.js";
import {
  EXTERNAL_ACTIVITY_COLUMNS,
  addFtpHistoryEntry,
  replaceActivityStreams,
  toExternalActivity,
  upsertBodyWeights,
  upsertDailyTrainingLoad,
  upsertExternalActivities,
  upsertSyncState,
} from "../data/supabase.js";
import type {
  ActivitySource,
  ActivityStream,
  ActivityStreamInput,
  AthleteSettings,
  BodyWeightInput,
  DailyTrainingLoad,
  ExternalActivity,
  ExternalActivityInput,
  FtpHistoryEntry,
  FtpSource,
  StreamChannel,
  SyncSource,
  SyncState,
} from "../types.js";
import type { StoredCredential } from "./types.js";

/** Columns the sync rewrites in place, leaving provider_payload and every other column alone. */
export type ActivityDerivedPatch = Partial<
  Pick<
    ExternalActivity,
    | "normalizedPowerW"
    | "intensityFactor"
    | "tss"
    | "tssSource"
    | "ftpUsedW"
    | "ftpSource"
    | "avgHrBpm"
    | "maxHrBpm"
    | "hasHr"
    | "pairedActivityId"
  >
>;

export type SyncStateUpdate = Pick<SyncState, "source"> & Partial<Omit<SyncState, "source">>;

export type CredentialProvider = "peloton";

/**
 * Everything the sync reads and writes, scoped to one owner. Activity lists are oldest first.
 * Reads never return provider_payload.
 */
export interface SyncStore {
  readonly ownerUserId: string;

  getAthleteSettings(): Promise<AthleteSettings>;
  /** Oldest effectiveFrom first. */
  listFtpHistory(): Promise<FtpHistoryEntry[]>;
  /** Inserts the entries whose (effectiveFrom, source) is not stored yet; returns the inserted ones. */
  addFtpHistoryEntries(entries: readonly Omit<FtpHistoryEntry, "id">[]): Promise<FtpHistoryEntry[]>;

  hasActivity(source: ActivitySource, sourceId: string): Promise<boolean>;
  /** startedAt in [fromIso, toIso], oldest first. */
  listActivitiesBetween(fromIso: string, toIso: string): Promise<ExternalActivity[]>;
  /** Every activity, oldest first. */
  listAllActivities(): Promise<ExternalActivity[]>;
  /** Upserts on (user, source, sourceId), replacing every column. */
  upsertActivity(row: ExternalActivityInput): Promise<ExternalActivity>;
  /** Channels not passed are deleted. */
  replaceStreams(activityId: string, streams: ActivityStreamInput[]): Promise<void>;
  getStream(activityId: string, channel: StreamChannel): Promise<ActivityStream | null>;
  /** Updates only the patched columns; returns the stored row. */
  updateActivityDerived(activityId: string, patch: ActivityDerivedPatch): Promise<ExternalActivity>;

  upsertBodyWeights(rows: BodyWeightInput[]): Promise<void>;
  listStrengthSessions(): Promise<{ id: string; performedOn: string }[]>;
  getDailyLoad(date: string): Promise<DailyTrainingLoad | null>;
  upsertDailyTrainingLoad(rows: DailyTrainingLoad[]): Promise<void>;

  getSyncState(source: SyncSource): Promise<SyncState | null>;
  saveSyncState(row: SyncStateUpdate): Promise<SyncState>;

  getCredential(provider: CredentialProvider): Promise<StoredCredential | null>;
  /**
   * Compare-and-swap on rotated_at: writes `c` only when the stored row's rotatedAt equals
   * `expectedRotatedAt` (null: no row yet, or a row never rotated). False when the swap is lost.
   */
  saveCredential(provider: CredentialProvider, c: StoredCredential, expectedRotatedAt: string | null): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Supabase implementation. It runs under the service role, which bypasses RLS:
// every read filters on user_id itself, and the writes go through the
// userId-taking helpers of src/data/supabase.ts. List reads page with .range()
// because PostgREST caps a response at 1000 rows.
// ---------------------------------------------------------------------------

/** PostgREST's default max-rows. */
export const PAGE_SIZE = 1000;

type DbRow = Record<string, unknown>;
type DbResult = { data: unknown; error: unknown };

const FTP_HISTORY_COLUMNS = "id, effective_from, ftp_w, source, source_ref";
const ATHLETE_SETTINGS_COLUMNS =
  "manual_ftp_w, lthr_bpm, max_hr_bpm, resting_hr_bpm, strength_session_tss, no_power_tss_per_hour, units, week_start";
const DAILY_TRAINING_LOAD_COLUMNS = "date, tss_total, tss_by_source, ctl, atl, tsb";
const SYNC_STATE_COLUMNS =
  "source, cursor, last_run_at, last_success_at, items_fetched, items_upserted, last_error, backfill_complete, auth_status";
const CREDENTIAL_COLUMNS = "ciphertext, iv, auth_tag, key_id, access_expires_at, rotated_at, revoked_at";
const STREAM_COLUMNS = "activity_id, channel, start_offset_s, values";

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : (v as string));

/** [patch field, column] of every column updateActivityDerived may write. */
const DERIVED_COLUMNS: [keyof ActivityDerivedPatch, string][] = [
  ["normalizedPowerW", "normalized_power_w"],
  ["intensityFactor", "intensity_factor"],
  ["tss", "tss"],
  ["tssSource", "tss_source"],
  ["ftpUsedW", "ftp_used_w"],
  ["ftpSource", "ftp_source"],
  ["avgHrBpm", "avg_hr_bpm"],
  ["maxHrBpm", "max_hr_bpm"],
  ["hasHr", "has_hr"],
  ["pairedActivityId", "paired_activity_id"],
];

const toFtpHistoryEntry = (r: DbRow): FtpHistoryEntry => ({
  id: r.id as string,
  effectiveFrom: r.effective_from as string,
  ftpW: Number(r.ftp_w),
  source: r.source as FtpSource,
  sourceRef: str(r.source_ref),
});

const toAthleteSettings = (r: DbRow): AthleteSettings => ({
  manualFtpW: num(r.manual_ftp_w),
  lthrBpm: num(r.lthr_bpm),
  maxHrBpm: num(r.max_hr_bpm),
  restingHrBpm: num(r.resting_hr_bpm),
  strengthSessionTss: Number(r.strength_session_tss),
  noPowerTssPerHour: Number(r.no_power_tss_per_hour),
  units: r.units as AthleteSettings["units"],
  weekStart: r.week_start as AthleteSettings["weekStart"],
});

const toDailyTrainingLoad = (r: DbRow): DailyTrainingLoad => ({
  date: r.date as string,
  tssTotal: Number(r.tss_total),
  tssBySource: (r.tss_by_source as DailyTrainingLoad["tssBySource"]) ?? {},
  ctl: Number(r.ctl),
  atl: Number(r.atl),
  tsb: Number(r.tsb),
});

const toSyncState = (r: DbRow): SyncState => ({
  source: r.source as SyncSource,
  cursor: r.cursor ?? null,
  lastRunAt: str(r.last_run_at),
  lastSuccessAt: str(r.last_success_at),
  itemsFetched: Number(r.items_fetched),
  itemsUpserted: Number(r.items_upserted),
  lastError: str(r.last_error),
  backfillComplete: r.backfill_complete === true,
  authStatus: r.auth_status as SyncState["authStatus"],
});

const toCredential = (r: DbRow): StoredCredential => ({
  ciphertext: r.ciphertext as string,
  iv: r.iv as string,
  authTag: r.auth_tag as string,
  keyId: r.key_id as string,
  accessExpiresAt: str(r.access_expires_at),
  rotatedAt: str(r.rotated_at),
  revokedAt: str(r.revoked_at),
});

const fromCredential = (c: StoredCredential): DbRow => ({
  ciphertext: c.ciphertext,
  iv: c.iv,
  auth_tag: c.authTag,
  key_id: c.keyId,
  access_expires_at: c.accessExpiresAt,
  rotated_at: c.rotatedAt,
  revoked_at: c.revokedAt,
});

/** Reads every page of an ordered query: `page(from, to)` must apply `.range(from, to)`. */
async function readAll<T>(page: (from: number, to: number) => PromiseLike<DbResult>, map: (r: DbRow) => T): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as DbRow[];
    for (const r of rows) out.push(map(r));
    if (rows.length < PAGE_SIZE) return out;
  }
}

function single<T>({ data, error }: DbResult, map: (r: DbRow) => T): T | null {
  if (error) throw error;
  return data ? map(data as DbRow) : null;
}

/** Postgres unique_violation. */
const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";

export function createSupabaseSyncStore(client: SupabaseClient, ownerUserId: string): SyncStore {
  const activities = () => client.from("external_activities").select(EXTERNAL_ACTIVITY_COLUMNS).eq("user_id", ownerUserId);

  const store: SyncStore = {
    ownerUserId,

    async getAthleteSettings() {
      const res = await client.from("athlete_settings").select(ATHLETE_SETTINGS_COLUMNS).eq("user_id", ownerUserId).maybeSingle();
      return single(res, toAthleteSettings) ?? { ...DEFAULT_ATHLETE_SETTINGS };
    },
    listFtpHistory() {
      return readAll(
        (from, to) =>
          client
            .from("ftp_history")
            .select(FTP_HISTORY_COLUMNS)
            .eq("user_id", ownerUserId)
            .order("effective_from")
            .order("id")
            .range(from, to),
        toFtpHistoryEntry,
      );
    },
    async addFtpHistoryEntries(entries) {
      const existing = await store.listFtpHistory();
      const seen = new Set(existing.map((e) => `${Date.parse(e.effectiveFrom)}\u0000${e.source}`));
      const added: FtpHistoryEntry[] = [];
      for (const e of entries) {
        const key = `${Date.parse(e.effectiveFrom)}\u0000${e.source}`;
        if (seen.has(key)) continue;
        seen.add(key);
        added.push(await addFtpHistoryEntry(client, e, ownerUserId));
      }
      return added;
    },

    async hasActivity(source, sourceId) {
      const { data, error } = await client
        .from("external_activities")
        .select("id")
        .eq("user_id", ownerUserId)
        .eq("source", source)
        .eq("source_id", sourceId)
        .maybeSingle();
      if (error) throw error;
      return data !== null;
    },
    listActivitiesBetween(fromIso, toIso) {
      return readAll(
        (from, to) =>
          activities()
            .gte("started_at", fromIso)
            .lte("started_at", toIso)
            .order("started_at")
            .order("id")
            .range(from, to),
        toExternalActivity,
      );
    },
    listAllActivities() {
      return readAll((from, to) => activities().order("started_at").order("id").range(from, to), toExternalActivity);
    },
    async upsertActivity(row) {
      const [stored] = await upsertExternalActivities(client, [row], ownerUserId);
      if (!stored) throw new Error(`upsert of ${row.source}/${row.sourceId} returned no row`);
      return stored;
    },
    replaceStreams(activityId, streams) {
      return replaceActivityStreams(client, activityId, streams, ownerUserId);
    },
    async getStream(activityId, channel) {
      const res = await client
        .from("activity_streams")
        .select(STREAM_COLUMNS)
        .eq("user_id", ownerUserId)
        .eq("activity_id", activityId)
        .eq("channel", channel)
        .maybeSingle();
      return single(res, (r) => ({
        activityId: r.activity_id as string,
        channel: r.channel as StreamChannel,
        startOffsetS: Number(r.start_offset_s),
        values: (r.values as (number | null)[]) ?? [],
      }));
    },
    async updateActivityDerived(activityId, patch) {
      const row: DbRow = { updated_at: new Date().toISOString() };
      for (const [field, column] of DERIVED_COLUMNS) {
        const v = patch[field];
        if (v === undefined) continue;
        // ftp_used_w is an integer column.
        row[column] = field === "ftpUsedW" && typeof v === "number" ? Math.round(v) : v;
      }
      const res = await client
        .from("external_activities")
        .update(row)
        .eq("user_id", ownerUserId)
        .eq("id", activityId)
        .select(EXTERNAL_ACTIVITY_COLUMNS)
        .single();
      const stored = single(res, toExternalActivity);
      if (!stored) throw new Error(`no activity ${activityId}`);
      return stored;
    },

    upsertBodyWeights(rows) {
      return upsertBodyWeights(client, rows, ownerUserId);
    },
    listStrengthSessions() {
      return readAll(
        (from, to) =>
          client
            .from("sessions")
            .select("id, performed_on")
            .eq("user_id", ownerUserId)
            .order("performed_on")
            .order("id")
            .range(from, to),
        (r) => ({ id: r.id as string, performedOn: r.performed_on as string }),
      );
    },
    async getDailyLoad(date) {
      const res = await client
        .from("daily_training_load")
        .select(DAILY_TRAINING_LOAD_COLUMNS)
        .eq("user_id", ownerUserId)
        .eq("date", date)
        .maybeSingle();
      return single(res, toDailyTrainingLoad);
    },
    async upsertDailyTrainingLoad(rows) {
      // One request per 1000 rows keeps a full rebuild under request-size limits.
      for (let i = 0; i < rows.length; i += PAGE_SIZE) {
        await upsertDailyTrainingLoad(client, rows.slice(i, i + PAGE_SIZE), ownerUserId);
      }
    },

    async getSyncState(source) {
      const res = await client
        .from("sync_state")
        .select(SYNC_STATE_COLUMNS)
        .eq("user_id", ownerUserId)
        .eq("source", source)
        .maybeSingle();
      return single(res, toSyncState);
    },
    saveSyncState(row) {
      return upsertSyncState(client, row, ownerUserId);
    },

    async getCredential(provider) {
      const res = await client
        .from("provider_credentials")
        .select(CREDENTIAL_COLUMNS)
        .eq("user_id", ownerUserId)
        .eq("provider", provider)
        .maybeSingle();
      return single(res, toCredential);
    },
    async saveCredential(provider, c, expectedRotatedAt) {
      const base = client
        .from("provider_credentials")
        .update({ ...fromCredential(c), updated_at: new Date().toISOString() })
        .eq("user_id", ownerUserId)
        .eq("provider", provider);
      const guarded = expectedRotatedAt === null ? base.is("rotated_at", null) : base.eq("rotated_at", expectedRotatedAt);
      const { data, error } = await guarded.select("id");
      if (error) throw error;
      if (((data ?? []) as unknown[]).length > 0) return true;
      if (expectedRotatedAt !== null) return false;
      // No row was never-rotated: either there is no row yet (insert it) or another writer won.
      const inserted = await client
        .from("provider_credentials")
        .insert({ ...fromCredential(c), user_id: ownerUserId, provider })
        .select("id");
      if (inserted.error) {
        if (isUniqueViolation(inserted.error)) return false;
        throw inserted.error;
      }
      return true;
    },
  };
  return store;
}
