/** In-memory SyncStore for tests. Mirrors the Supabase store: upserts replace every column, reads omit providerPayload. */
import { DEFAULT_ATHLETE_SETTINGS } from "../../data/DataLayer.js";
import type {
  ActivityStream,
  AthleteSettings,
  BodyWeightInput,
  DailyTrainingLoad,
  ExternalActivity,
  ExternalActivityInput,
  FtpHistoryEntry,
  SyncState,
} from "../../types.js";
import type { SyncStore } from "../store.js";
import type { StoredCredential } from "../types.js";

export interface MemorySyncSeed {
  settings?: Partial<AthleteSettings>;
  ftpHistory?: FtpHistoryEntry[];
  activities?: ExternalActivity[];
  streams?: ActivityStream[];
  strengthSessions?: { id: string; performedOn: string }[];
  dailyLoad?: DailyTrainingLoad[];
  syncState?: SyncState[];
  credential?: StoredCredential | null;
}

export interface MemorySyncStore extends SyncStore {
  /** The raw state, for assertions. Payloads are kept here even though reads omit them. */
  readonly state: {
    settings: AthleteSettings;
    ftpHistory: FtpHistoryEntry[];
    activities: Map<string, ExternalActivity>;
    payloads: Map<string, unknown>;
    streams: Map<string, ActivityStream[]>;
    bodyWeights: BodyWeightInput[];
    strengthSessions: { id: string; performedOn: string }[];
    dailyLoad: Map<string, DailyTrainingLoad>;
    syncState: Map<string, SyncState>;
    credential: StoredCredential | null;
  };
}

const byStart = (a: ExternalActivity, b: ExternalActivity) =>
  Date.parse(a.startedAt) - Date.parse(b.startedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const sameInstant = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);

function toRow(id: string, a: ExternalActivityInput, now: string): ExternalActivity {
  return {
    id,
    source: a.source,
    sourceId: a.sourceId,
    startedAt: a.startedAt,
    timezone: a.timezone ?? null,
    sport: a.sport,
    subType: a.subType ?? null,
    environment: a.environment,
    title: a.title ?? null,
    elapsedS: a.elapsedS ?? null,
    movingS: a.movingS ?? null,
    distanceM: a.distanceM ?? null,
    elevationGainM: a.elevationGainM ?? null,
    avgSpeedMps: a.avgSpeedMps ?? null,
    maxSpeedMps: a.maxSpeedMps ?? null,
    avgPowerW: a.avgPowerW ?? null,
    maxPowerW: a.maxPowerW ?? null,
    normalizedPowerW: a.normalizedPowerW ?? null,
    intensityFactor: a.intensityFactor ?? null,
    tss: a.tss ?? null,
    workKj: a.workKj ?? null,
    calories: a.calories ?? null,
    avgHrBpm: a.avgHrBpm ?? null,
    maxHrBpm: a.maxHrBpm ?? null,
    avgCadenceRpm: a.avgCadenceRpm ?? null,
    biggestClimbM: a.biggestClimbM ?? null,
    tssSource: a.tssSource ?? null,
    ftpUsedW: a.ftpUsedW === null || a.ftpUsedW === undefined ? null : Math.round(a.ftpUsedW),
    ftpSource: a.ftpSource ?? null,
    hasPower: a.hasPower ?? false,
    hasHr: a.hasHr ?? false,
    powerCurve: a.powerCurve ?? null,
    bestEfforts: a.bestEfforts ?? null,
    pairedActivityId: a.pairedActivityId ?? null,
    syncedAt: now,
  };
}

export function createMemorySyncStore(ownerUserId: string, seed: MemorySyncSeed = {}): MemorySyncStore {
  let nextId = 1;
  const state: MemorySyncStore["state"] = {
    settings: { ...DEFAULT_ATHLETE_SETTINGS, ...seed.settings },
    ftpHistory: [...(seed.ftpHistory ?? [])],
    activities: new Map((seed.activities ?? []).map((a) => [a.id, { ...a }])),
    payloads: new Map(),
    streams: new Map(),
    bodyWeights: [],
    strengthSessions: [...(seed.strengthSessions ?? [])],
    dailyLoad: new Map((seed.dailyLoad ?? []).map((d) => [d.date, { ...d }])),
    syncState: new Map((seed.syncState ?? []).map((s) => [s.source, { ...s }])),
    credential: seed.credential ?? null,
  };
  for (const s of seed.streams ?? []) {
    const list = state.streams.get(s.activityId) ?? [];
    list.push({ ...s });
    state.streams.set(s.activityId, list);
  }
  const copy = (a: ExternalActivity): ExternalActivity => ({ ...a });
  const sorted = () => [...state.activities.values()].sort(byStart).map(copy);

  return {
    ownerUserId,
    state,

    async getAthleteSettings() {
      return { ...state.settings };
    },
    async listFtpHistory() {
      return [...state.ftpHistory].sort((a, b) => Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom));
    },
    async addFtpHistoryEntries(entries) {
      const added: FtpHistoryEntry[] = [];
      for (const e of entries) {
        const exists = state.ftpHistory.some((h) => h.source === e.source && sameInstant(h.effectiveFrom, e.effectiveFrom));
        if (exists) continue;
        const entry = { ...e, id: `ftp-${nextId++}`, sourceRef: e.sourceRef ?? null };
        state.ftpHistory.push(entry);
        added.push({ ...entry });
      }
      return added;
    },
    async deleteFtpHistoryEntries(ids) {
      const gone = new Set(ids);
      const before = state.ftpHistory.length;
      state.ftpHistory = state.ftpHistory.filter((h) => !gone.has(h.id));
      return before - state.ftpHistory.length;
    },

    async hasActivity(source, sourceId) {
      return [...state.activities.values()].some((a) => a.source === source && a.sourceId === sourceId);
    },
    async listActivitiesBetween(fromIso, toIso) {
      const from = Date.parse(fromIso);
      const to = Date.parse(toIso);
      return sorted().filter((a) => {
        const t = Date.parse(a.startedAt);
        return t >= from && t <= to;
      });
    },
    async listAllActivities() {
      return sorted();
    },
    async upsertActivity(row) {
      if (row.providerPayload === undefined || row.providerPayload === null) {
        throw new Error(`external activity ${row.source}/${row.sourceId} has no providerPayload`);
      }
      const existing = [...state.activities.values()].find((a) => a.source === row.source && a.sourceId === row.sourceId);
      const id = existing?.id ?? `act-${nextId++}`;
      const stored = toRow(id, row, new Date().toISOString());
      state.activities.set(id, stored);
      state.payloads.set(id, row.providerPayload);
      return copy(stored);
    },
    async replaceStreams(activityId, streams) {
      const byChannel = new Map(
        streams.map((s) => [s.channel, { activityId, channel: s.channel, startOffsetS: s.startOffsetS ?? 0, values: [...s.values] }]),
      );
      state.streams.set(activityId, [...byChannel.values()]);
    },
    async getStream(activityId, channel) {
      const s = state.streams.get(activityId)?.find((x) => x.channel === channel);
      return s ? { ...s, values: [...s.values] } : null;
    },
    async updateActivityDerived(activityId, patch) {
      const a = state.activities.get(activityId);
      if (!a) throw new Error(`no activity ${activityId}`);
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const next = { ...a, ...defined };
      if (next.ftpUsedW !== null) next.ftpUsedW = Math.round(next.ftpUsedW);
      state.activities.set(activityId, next);
      return copy(next);
    },

    async upsertBodyWeights(rows) {
      for (const w of rows) {
        const i = state.bodyWeights.findIndex((x) => x.source === w.source && x.sourceId === w.sourceId);
        if (i >= 0) state.bodyWeights[i] = { ...w };
        else state.bodyWeights.push({ ...w });
      }
    },
    async listStrengthSessions() {
      return state.strengthSessions.map((s) => ({ ...s }));
    },
    async getDailyLoad(date) {
      const d = state.dailyLoad.get(date);
      return d ? { ...d, tssBySource: { ...d.tssBySource } } : null;
    },
    async upsertDailyTrainingLoad(rows) {
      for (const r of rows) state.dailyLoad.set(r.date, { ...r, tssBySource: { ...r.tssBySource } });
    },

    async getSyncState(source) {
      const s = state.syncState.get(source);
      return s ? { ...s } : null;
    },
    async saveSyncState(row) {
      const prev: SyncState = state.syncState.get(row.source) ?? {
        source: row.source,
        cursor: null,
        lastRunAt: null,
        lastSuccessAt: null,
        itemsFetched: 0,
        itemsUpserted: 0,
        lastError: null,
        backfillComplete: false,
        authStatus: "ok",
      };
      const defined = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
      const next = { ...prev, ...defined } as SyncState;
      state.syncState.set(row.source, next);
      return { ...next };
    },

    async getCredential() {
      return state.credential ? { ...state.credential } : null;
    },
    async saveCredential(_provider, c, expectedRotatedAt) {
      const current = state.credential;
      if (current === null ? expectedRotatedAt !== null : !sameInstant(current.rotatedAt, expectedRotatedAt)) return false;
      state.credential = { ...c };
      return true;
    },
  };
}
