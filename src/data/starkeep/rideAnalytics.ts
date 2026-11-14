/**
 * The 14 ride analytics DataLayer methods (AI-631) over Starkeep's row API,
 * spread into `createStarkeepDataLayerFromRows` (`../starkeep.ts`). Semantics
 * follow `src/data/supabase.ts` method for method; ids, JSON-in-text columns
 * and row mapping are `./rideRows.ts` (epic AI-822, decisions 1 and 2).
 *
 * What Postgres did for free, done by hand:
 * - Unique constraints are the deterministic ids, and the row API's POST
 *   upserts on the id, which is what Supabase's `onConflict` targets did. A
 *   batch is collapsed to one row per id first (last one wins), as supabase.ts
 *   does.
 * - A POST replaces the whole row, so an upsert of an existing row reads its
 *   `created_at` first and keeps it (Postgres never touched it on conflict).
 * - `addFtpHistoryEntry` checks for an existing id before inserting (the
 *   unique constraint rejected a second entry). Read-then-write: two
 *   concurrent adds of the same entry can both succeed, the second
 *   overwriting the first with the same key.
 * - `replaceActivityStreams` checks the activity exists before writing streams
 *   (the foreign key) and deletes the channels not passed, then upserts the rest.
 * - No transactions: a batch is one POST per row (a few at a time), so a
 *   failure part-way leaves the rows before it written. Every write is an
 *   idempotent upsert on its id, so retrying the batch converges. The first
 *   saveAthleteSettings creates the row with a full POST: two concurrent first
 *   saves can lose one patch (later saves PATCH only their columns).
 * - Lists use `selectAll` (or follow page tokens up to `limit`), so nothing is
 *   cut at 500 rows. Instants are compared as canonical ISO text, which is
 *   how they are stored; `daily_training_load.date` as `YYYY-MM-DD`.
 */
import { assertListLimit, assertProviderPayloads, DEFAULT_ATHLETE_SETTINGS, type DataLayer } from "../DataLayer.js";
import { compareText } from "../../analysis/sqlSemantics.js";
import { MAX_PAGE, RowApiError, type Row, type RowClient, type SelectOptions, type Where, type WhereOps } from "./rows.js";
import { chunks, selectIn } from "./select.js";
import {
  ATHLETE_SETTINGS_ID,
  athleteSettingsPatch,
  BODY_WEIGHT_READ_COLUMNS,
  bodyWeightId,
  calendarDate,
  dailyTrainingLoadId,
  EXTERNAL_ACTIVITY_READ_COLUMNS,
  externalActivityId,
  fromActivityStreamRow,
  fromAthleteSettingsRow,
  fromBodyWeightRow,
  fromDailyTrainingLoadRow,
  fromExternalActivityRow,
  fromFtpHistoryRow,
  fromSyncStateRow,
  isoInstant,
  RIDE_TABLES as T,
  toActivityStreamRow,
  toAthleteSettingsRow,
  toBodyWeightRow,
  toDailyTrainingLoadRow,
  toExternalActivityRow,
  toFtpHistoryRow,
  type ActivityStreamRow,
  type AthleteSettingsRow,
  type BodyWeightRow,
  type DailyTrainingLoadRow,
  type ExternalActivityRow,
  type FtpHistoryRow,
  type SyncStateRow,
} from "./rideRows.js";

export type RideAnalyticsMethods = Pick<
  DataLayer,
  | "listExternalActivities" | "getExternalActivity" | "upsertExternalActivities" | "getActivityStreams"
  | "replaceActivityStreams" | "listBodyWeights" | "upsertBodyWeights" | "getAthleteSettings"
  | "saveAthleteSettings" | "listFtpHistory" | "addFtpHistoryEntry" | "listDailyTrainingLoad"
  | "upsertDailyTrainingLoad" | "listSyncState"
>;

const now = () => new Date().toISOString();

/** POSTs in flight at once when writing a batch. */
const WRITE_CONCURRENCY = 8;

/** `rows` with one row per key, the last one for each key, in first-appearance order. */
function lastByKey<R>(items: readonly R[], key: (row: R) => string): R[] {
  const byKey = new Map<string, R>();
  for (const item of items) byKey.set(key(item), item);
  return [...byKey.values()];
}

/** `[gte, lte]` on one column, leaving out an undefined bound; undefined when both are. */
function between(gte: string | undefined, lte: string | undefined): WhereOps | undefined {
  if (gte === undefined && lte === undefined) return undefined;
  const ops: WhereOps = {};
  if (gte !== undefined) ops.gte = gte;
  if (lte !== undefined) ops.lte = lte;
  return ops;
}

export function createRideAnalytics(rows: RowClient): RideAnalyticsMethods {
  async function first<R extends Row>(table: string, where: Where, select?: string[]): Promise<R | null> {
    const { rows: found } = await rows.select<R>(table, { where, select, limit: 1 });
    return found[0] ?? null;
  }

  /** At most `limit` rows in `opts.order`, following page tokens (a page can stop short of its limit). */
  async function selectUpTo<R extends Row>(table: string, opts: Omit<SelectOptions, "limit" | "pageToken">, limit: number): Promise<R[]> {
    const out: R[] = [];
    let pageToken: string | undefined;
    while (out.length < limit) {
      const page = await rows.select<R>(table, { ...opts, limit: Math.min(MAX_PAGE, limit), pageToken });
      out.push(...page.rows);
      if (page.pageToken) {
        pageToken = page.pageToken;
        continue;
      }
      if (page.truncated && out.length < limit) throw new RowApiError(table, 200, "response truncated without a page_token");
      break;
    }
    return out.slice(0, limit);
  }

  /** created_at of the rows among `ids` that already exist, by id. */
  async function existingCreatedAt(table: string, ids: string[]): Promise<Map<string, string>> {
    const found = await selectIn<{ id: string; created_at: string | null }>(rows, table, "id", ids, { select: ["id", "created_at"] });
    const out = new Map<string, string>();
    for (const r of found) if (r.created_at) out.set(r.id, r.created_at);
    return out;
  }

  /** POST every row (distinct ids), {@link WRITE_CONCURRENCY} at a time: the row API has no bulk insert. */
  async function insertAll(table: string, written: Row[]): Promise<void> {
    for (const part of chunks(written, WRITE_CONCURRENCY)) await Promise.all(part.map((row) => rows.insert(table, row)));
  }

  async function getAthleteSettings() {
    const row = await first<AthleteSettingsRow>(T.settings, { id: ATHLETE_SETTINGS_ID });
    return row ? fromAthleteSettingsRow(row) : { ...DEFAULT_ATHLETE_SETTINGS };
  }

  return {
    async listExternalActivities(f) {
      assertListLimit(f.limit);
      if (f.limit === 0) return [];
      const where: Where = {};
      const startedAt = between(
        f.from === undefined ? undefined : isoInstant(f.from, "from", "up"),
        f.to === undefined ? undefined : isoInstant(f.to, "to"),
      );
      if (startedAt) where.started_at = startedAt;
      if (f.source !== undefined) where.source = f.source;
      if (f.environment !== undefined) where.environment = f.environment;
      // id breaks started_at ties, as in supabase.ts.
      const opts = { where, select: EXTERNAL_ACTIVITY_READ_COLUMNS, order: ["started_at.desc", "id.asc"] };
      const found =
        f.limit === undefined
          ? await rows.selectAll<ExternalActivityRow>(T.activities, opts)
          : await selectUpTo<ExternalActivityRow>(T.activities, opts, f.limit);
      return found.map(fromExternalActivityRow);
    },

    async getExternalActivity(id) {
      const row = await first<ExternalActivityRow>(T.activities, { id }, EXTERNAL_ACTIVITY_READ_COLUMNS);
      return row ? fromExternalActivityRow(row) : null;
    },

    async upsertExternalActivities(input) {
      if (input.length === 0) return [];
      assertProviderPayloads(input);
      const at = now();
      const deduped = lastByKey(input, (a) => externalActivityId(a.source, a.sourceId));
      const created = await existingCreatedAt(T.activities, deduped.map((a) => externalActivityId(a.source, a.sourceId)));
      // Map every row before writing any, so a bad row fails the batch up front.
      const written = deduped.map((a) =>
        toExternalActivityRow(a, { now: at, createdAt: created.get(externalActivityId(a.source, a.sourceId)) }),
      );
      await insertAll(T.activities, written);
      return written.map(({ provider_payload: _payload, created_at: _created, ...row }) => fromExternalActivityRow(row));
    },

    async getActivityStreams(activityId) {
      const found = await rows.selectAll<ActivityStreamRow>(T.streams, {
        where: { activity_id: activityId },
        order: ["channel.asc"],
      });
      // supabase.ts orders by channel in en_US collation; compareText is its port.
      return found.map(fromActivityStreamRow).sort((a, b) => compareText(a.channel, b.channel));
    },

    async replaceActivityStreams(activityId, streams) {
      const deduped = lastByKey(streams, (s) => s.channel);
      const [activity, existing] = await Promise.all([
        deduped.length > 0 ? first(T.activities, { id: activityId }, ["id"]) : null,
        rows.selectAll<{ id: string; channel: string; created_at: string | null }>(T.streams, {
          where: { activity_id: activityId },
          select: ["id", "channel", "created_at"],
        }),
      ]);
      // activity_id references external_activities(id): mirror the foreign key.
      if (deduped.length > 0 && !activity) throw new Error(`External activity ${activityId} not found`);
      // Replace, not merge: drop the channels absent from the new set (all of
      // them for an empty set), then upsert the rest.
      const keep = new Set<string>(deduped.map((s) => s.channel));
      const doomed = existing.filter((r) => !keep.has(r.channel)).map((r) => r.id);
      for (const part of chunks(doomed)) await rows.remove(T.streams, { id: { in: part } });
      if (deduped.length === 0) return;
      const at = now();
      const created = new Map(existing.map((r) => [r.id, r.created_at]));
      await insertAll(
        T.streams,
        deduped.map((s) => {
          const row = toActivityStreamRow(activityId, s, { now: at });
          return { ...row, created_at: created.get(row.id) ?? at };
        }),
      );
    },

    async listBodyWeights(from, to) {
      const found = await rows.selectAll<BodyWeightRow>(T.bodyWeights, {
        where: { measured_at: between(isoInstant(from, "from", "up"), isoInstant(to, "to"))! },
        select: BODY_WEIGHT_READ_COLUMNS,
        order: ["measured_at.asc", "id.asc"],
      });
      return found.map(fromBodyWeightRow);
    },

    async upsertBodyWeights(input) {
      if (input.length === 0) return;
      const at = now();
      const deduped = lastByKey(input, (w) => bodyWeightId(w.source, w.sourceId));
      const created = await existingCreatedAt(T.bodyWeights, deduped.map((w) => bodyWeightId(w.source, w.sourceId)));
      const written = deduped.map((w) => toBodyWeightRow(w, { now: at, createdAt: created.get(bodyWeightId(w.source, w.sourceId)) }));
      await insertAll(T.bodyWeights, written);
    },

    getAthleteSettings,

    async saveAthleteSettings(patch) {
      const columns = athleteSettingsPatch(patch);
      if (Object.keys(columns).length === 0) return getAthleteSettings();
      const existing = await first<AthleteSettingsRow>(T.settings, { id: ATHLETE_SETTINGS_ID });
      if (existing) {
        // Only the sent columns change; PATCH leaves the others alone.
        await rows.patch(T.settings, { id: ATHLETE_SETTINGS_ID }, columns);
        return fromAthleteSettingsRow({ ...existing, ...columns });
      }
      // No row yet: the other columns take their defaults.
      const row = toAthleteSettingsRow(patch, { now: now() });
      await rows.insert(T.settings, row);
      return fromAthleteSettingsRow(row);
    },

    async listFtpHistory() {
      const found = await rows.selectAll<FtpHistoryRow>(T.ftp, {
        order: ["effective_from.asc", "created_at.asc", "id.asc"],
      });
      return found.map(fromFtpHistoryRow);
    },

    async addFtpHistoryEntry(entry) {
      // ftp_w is `integer not null check (ftp_w > 0)` in Postgres.
      if (!(Number.isInteger(entry.ftpW) && entry.ftpW > 0)) throw new Error(`ftpW must be a positive integer, got ${entry.ftpW}`);
      const row = toFtpHistoryRow(entry, { now: now() });
      // unique (user_id, effective_from, source): the id is that key.
      if (await first(T.ftp, { id: row.id }, ["id"])) {
        throw new Error(`An FTP entry from ${entry.source} at ${row.effective_from} already exists`);
      }
      await rows.insert(T.ftp, row);
      return fromFtpHistoryRow(row);
    },

    async listDailyTrainingLoad(from, to) {
      const found = await rows.selectAll<DailyTrainingLoadRow>(T.dailyLoad, {
        where: { date: between(calendarDate(from, "from"), calendarDate(to, "to"))! },
        order: ["date.asc"],
      });
      return found.map(fromDailyTrainingLoadRow);
    },

    async upsertDailyTrainingLoad(input) {
      if (input.length === 0) return;
      const at = now();
      const deduped = lastByKey(input, (d) => dailyTrainingLoadId(d.date));
      const created = await existingCreatedAt(T.dailyLoad, deduped.map((d) => dailyTrainingLoadId(d.date)));
      const written = deduped.map((d) => toDailyTrainingLoadRow(d, { now: at, createdAt: created.get(dailyTrainingLoadId(d.date)) }));
      await insertAll(T.dailyLoad, written);
    },

    async listSyncState() {
      const found = await rows.selectAll<SyncStateRow>(T.syncState, { order: ["source.asc"] });
      // supabase.ts orders by source in en_US collation; compareText is its port.
      return found.map(fromSyncStateRow).sort((a, b) => compareText(a.source, b.source));
    },
  };
}
