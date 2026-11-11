import { DEFAULT_ATHLETE_SETTINGS, assertListLimit, assertProviderPayloads, type DataLayer } from "./DataLayer";
import type {
  Exercise,
  WorkoutDay,
  Session,
  SetEntry,
  Program,
  ExternalActivity,
  ActivityStream,
  BodyWeight,
  AthleteSettings,
  FtpHistoryEntry,
  DailyTrainingLoad,
} from "../types";
import { seedExercises, seedDays, seedSessions } from "./seed";
import { findLastSetsForExercise } from "../lib/lastSession";
import { nextAvailablePositionByProgram, isDayAvailable } from "../lib/programAvailability";
import { compareText, timestampMicros } from "../analysis/sqlSemantics";

type StoredDay = Omit<WorkoutDay, "programName" | "isAvailable">;

export function createMockDataLayer(opts?: { seed?: boolean }): DataLayer {
  const useSeed = opts?.seed !== false;
  const exercises: Exercise[] = useSeed ? structuredClone(seedExercises) : [];
  const days: StoredDay[] = useSeed ? structuredClone(seedDays) : [];
  const programs: Program[] = [];
  const sessions: Session[] = useSeed ? structuredClone(seedSessions) : [];
  const targets: Record<string, Record<string, SetEntry[]>> = {};
  const schemeHistory: Record<string, { targetSets: SetEntry[] | null; recordedAt: string }[]> = {};
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;
  let seedClaimed = false;

  // Ride analytics (AI-631): same keys, defaults and ordering as supabase.ts.
  // Provider payloads are write-only there, so the mock does not keep them.
  const activities: ExternalActivity[] = [];
  const streams: ActivityStream[] = [];
  const bodyWeights: BodyWeight[] = [];
  let athleteSettings: AthleteSettings | null = null;
  const ftpHistory: FtpHistoryEntry[] = [];
  const trainingLoad = new Map<string, DailyTrainingLoad>();
  // Exact timestamptz instants (microseconds, bigint) that accept Postgres-style
  // literals such as "2026-11-01 10:00:00+00" and throw on garbage rather than
  // comparing NaN silently.
  const instant = (ts: string) => timestampMicros(ts);
  const byInstant = (x: string, y: string) => Number(instant(x) - instant(y));

  return {
    async claimSeed() {
      if (seedClaimed) return false;
      seedClaimed = true;
      return true;
    },
    async listExercises() {
      return exercises.slice();
    },
    async getExercise(id) {
      return exercises.find((e) => e.id === id) ?? null;
    },
    async createExercise(input) {
      const ex: Exercise = { ...input, id: nextId("ex") };
      exercises.push(ex);
      return ex;
    },
    async updateExercise(id, patch) {
      const ex = exercises.find((e) => e.id === id);
      if (!ex) throw new Error(`Exercise ${id} not found`);
      if (patch.name !== undefined) ex.name = patch.name;
      if (patch.cue !== undefined) ex.cue = patch.cue;
      if (patch.defaultSets !== undefined) ex.defaultSets = patch.defaultSets;
      if (patch.defaultRepLow !== undefined) ex.defaultRepLow = patch.defaultRepLow;
      if (patch.defaultRepHigh !== undefined) ex.defaultRepHigh = patch.defaultRepHigh;
      return { ...ex };
    },
    async deleteExercise(id) {
      // The mock has no soft-delete column; dropping the exercise is what makes
      // it disappear from listExercises, as Supabase's deleted_at does.
      const idx = exercises.findIndex((e) => e.id === id);
      if (idx !== -1) exercises.splice(idx, 1);
    },
    async findDayByName(name) {
      const d = days.find((day) => day.name === name);
      return d ? { id: d.id, name: d.name, position: d.position, programId: d.programId, programPosition: d.programPosition } : null;
    },
    async findExerciseByName(name) {
      return exercises.find((e) => e.name === name) ?? null;
    },
    async findProgramByName(name) {
      return programs.find((p) => p.name === name) ?? null;
    },
    async getWorkoutDays() {
      const completed = new Set(
        sessions.filter((s) => s.workoutDayId !== null && s.exercises.length > 0).map((s) => s.workoutDayId as string),
      );
      const livingProgramIds = new Set(programs.map((p) => p.id));
      const effectiveProgramIdByDay = new Map(
        days.map((d) => [d.id, d.programId && livingProgramIds.has(d.programId) ? d.programId : null]),
      );
      const availabilityInput = days.map((d) => ({ id: d.id, programId: effectiveProgramIdByDay.get(d.id)!, programPosition: d.programPosition }));
      const nextByProgram = nextAvailablePositionByProgram(availabilityInput, completed);
      return days
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((d) => {
          const effectiveProgramId = effectiveProgramIdByDay.get(d.id)!;
          const program = effectiveProgramId ? programs.find((p) => p.id === effectiveProgramId) ?? null : null;
          return {
            ...d,
            // Override, don't just spread ...d: once a program is deleted, its former
            // days must report programId/programPosition null too (matching
            // src/data/supabase.ts's getWorkoutDays, which nulls these the same way for
            // a day whose program_id points at a soft-deleted row) — not just programName.
            programId: effectiveProgramId,
            programPosition: effectiveProgramId ? d.programPosition : null,
            programName: program ? program.name : null,
            isAvailable: isDayAvailable({ id: d.id, programId: effectiveProgramId, programPosition: d.programPosition }, nextByProgram),
          };
        });
    },
    async getDayExercises(dayId) {
      const day = days.find((d) => d.id === dayId);
      if (!day) return [];
      return day.exerciseIds
        .map((id) => exercises.find((e) => e.id === id))
        .filter((e): e is Exercise => !!e);
    },
    async createDay(name) {
      const day: StoredDay = { id: nextId("day"), name, position: days.length, exerciseIds: [], programId: null, programPosition: null };
      days.push(day);
      return { ...day, programName: null, isAvailable: true };
    },
    async deleteDay(dayId) {
      const idx = days.findIndex((d) => d.id === dayId);
      if (idx !== -1) days.splice(idx, 1);
      delete targets[dayId];
    },
    async addExerciseToDay(dayId, exerciseId) {
      const day = days.find((d) => d.id === dayId);
      if (day && !day.exerciseIds.includes(exerciseId)) day.exerciseIds.push(exerciseId);
    },
    async removeExerciseFromDay(dayId, exerciseId) {
      const day = days.find((d) => d.id === dayId);
      if (day) day.exerciseIds = day.exerciseIds.filter((id) => id !== exerciseId);
      const dayTargets = targets[dayId];
      if (dayTargets) delete dayTargets[exerciseId];
    },
    async updateDayExercises(dayId, exerciseIds) {
      const day = days.find((d) => d.id === dayId);
      if (day) day.exerciseIds = exerciseIds.slice();
      const dayTargets = targets[dayId];
      if (dayTargets) {
        for (const exId of Object.keys(dayTargets)) {
          if (!exerciseIds.includes(exId)) delete dayTargets[exId];
        }
      }
    },
    async updateDayName(dayId, name) {
      const day = days.find((d) => d.id === dayId);
      if (day) day.name = name;
    },
    async createProgram(name) {
      const program: Program = { id: nextId("program"), name };
      programs.push(program);
      return program;
    },
    async renameProgram(programId, name) {
      const program = programs.find((p) => p.id === programId);
      if (program) program.name = name;
    },
    async deleteProgram(programId) {
      const idx = programs.findIndex((p) => p.id === programId);
      if (idx !== -1) programs.splice(idx, 1);
    },
    async addDayToProgram(dayId, programId) {
      const day = days.find((d) => d.id === dayId);
      if (!day) return;
      const maxPosition = days
        .filter((d) => d.programId === programId)
        .reduce((max, d) => Math.max(max, d.programPosition ?? -1), -1);
      day.programId = programId;
      day.programPosition = maxPosition + 1;
    },
    async removeDayFromProgram(dayId) {
      const day = days.find((d) => d.id === dayId);
      if (day) {
        day.programId = null;
        day.programPosition = null;
      }
    },
    async reorderProgramDays(programId, dayIds) {
      dayIds.forEach((dayId, index) => {
        const day = days.find((d) => d.id === dayId && d.programId === programId);
        if (day) day.programPosition = index;
      });
    },
    async getDayExerciseTargets(dayId) {
      return { ...(targets[dayId] ?? {}) };
    },
    async setDayExerciseTarget(dayId, exerciseId, sets) {
      const dayTargets = (targets[dayId] ??= {});
      if (sets && sets.length > 0) dayTargets[exerciseId] = sets.slice();
      else delete dayTargets[exerciseId];

      const key = `${dayId}:${exerciseId}`;
      (schemeHistory[key] ??= []).push({
        targetSets: sets && sets.length > 0 ? sets.slice() : null,
        recordedAt: new Date().toISOString(),
      });
    },
    async getSchemeHistory(dayId, exerciseId) {
      return (schemeHistory[`${dayId}:${exerciseId}`] ?? []).slice();
    },
    async getLastSetsForExercise(exerciseId, beforeDate) {
      return findLastSetsForExercise(sessions, exerciseId, beforeDate);
    },
    async startSession(workoutDayId, date) {
      const session: Session = { id: nextId("session"), workoutDayId, performedOn: date, exercises: [] };
      sessions.push(session);
      return session;
    },
    async getSession(id) {
      return sessions.find((s) => s.id === id) ?? null;
    },
    async logExercise(sessionId, exerciseId, sets) {
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;
      const existing = session.exercises.find((e) => e.exerciseId === exerciseId);
      if (existing) existing.sets = sets.slice();
      else session.exercises.push({ exerciseId, sets: sets.slice() });
    },
    async getExerciseHistory(exerciseId) {
      return sessions
        .filter((s) => s.exercises.some((e) => e.exerciseId === exerciseId))
        .sort((a, b) => (a.performedOn < b.performedOn ? 1 : -1));
    },
    async getLastSessionForDay(workoutDayId) {
      let best: Session | null = null;
      for (const s of sessions) {
        if (s.workoutDayId !== workoutDayId || s.exercises.length === 0) continue;
        if (!best || s.performedOn >= best.performedOn) best = s;
      }
      return best;
    },
    async getSessionForDayAndDate(workoutDayId, date) {
      for (let i = sessions.length - 1; i >= 0; i--) {
        const s = sessions[i];
        if (s.workoutDayId === workoutDayId && s.performedOn === date) return s;
      }
      return null;
    },
    async listSessions() {
      return sessions
        .slice()
        .reverse()
        .sort((a, b) => (a.performedOn < b.performedOn ? 1 : a.performedOn > b.performedOn ? -1 : 0));
    },
    async deleteSession(id) {
      const idx = sessions.findIndex((s) => s.id === id);
      if (idx !== -1) sessions.splice(idx, 1);
    },

    async listExternalActivities(f) {
      assertListLimit(f.limit);
      if (f.limit === 0) return [];
      const out = activities
        .filter(
          (a) =>
            (f.from === undefined || instant(a.startedAt) >= instant(f.from)) &&
            (f.to === undefined || instant(a.startedAt) <= instant(f.to)) &&
            (f.source === undefined || a.source === f.source) &&
            (f.environment === undefined || a.environment === f.environment),
        )
        .sort((a, b) => byInstant(b.startedAt, a.startedAt))
        .map((a) => structuredClone(a));
      return f.limit === undefined ? out : out.slice(0, f.limit);
    },
    async getExternalActivity(id) {
      const a = activities.find((x) => x.id === id);
      return a ? structuredClone(a) : null;
    },
    async upsertExternalActivities(rows) {
      assertProviderPayloads(rows);
      const now = new Date().toISOString();
      // supabase.ts collapses rows sharing (source, sourceId) to the last one.
      const unique = [...new Map(rows.map((r) => [`${r.source}\u0000${r.sourceId}`, r])).values()];
      return unique.map((input) => {
        const { providerPayload: _payload, ...fields } = input;
        const existing = activities.find((a) => a.source === input.source && a.sourceId === input.sourceId);
        const row: ExternalActivity = {
          id: existing?.id ?? nextId("act"),
          source: fields.source,
          sourceId: fields.sourceId,
          startedAt: fields.startedAt,
          timezone: fields.timezone ?? null,
          sport: fields.sport,
          subType: fields.subType ?? null,
          environment: fields.environment,
          title: fields.title ?? null,
          elapsedS: fields.elapsedS ?? null,
          movingS: fields.movingS ?? null,
          distanceM: fields.distanceM ?? null,
          elevationGainM: fields.elevationGainM ?? null,
          avgSpeedMps: fields.avgSpeedMps ?? null,
          maxSpeedMps: fields.maxSpeedMps ?? null,
          avgPowerW: fields.avgPowerW ?? null,
          maxPowerW: fields.maxPowerW ?? null,
          normalizedPowerW: fields.normalizedPowerW ?? null,
          intensityFactor: fields.intensityFactor ?? null,
          tss: fields.tss ?? null,
          workKj: fields.workKj ?? null,
          calories: fields.calories ?? null,
          avgHrBpm: fields.avgHrBpm ?? null,
          maxHrBpm: fields.maxHrBpm ?? null,
          avgCadenceRpm: fields.avgCadenceRpm ?? null,
          biggestClimbM: fields.biggestClimbM ?? null,
          tssSource: fields.tssSource ?? null,
          ftpUsedW: fields.ftpUsedW == null ? null : Math.round(fields.ftpUsedW), // integer column
          ftpSource: fields.ftpSource ?? null,
          hasPower: fields.hasPower ?? false,
          hasHr: fields.hasHr ?? false,
          powerCurve: structuredClone(fields.powerCurve ?? null),
          bestEfforts: structuredClone(fields.bestEfforts ?? null),
          pairedActivityId: fields.pairedActivityId ?? null,
          syncedAt: now,
        };
        if (existing) activities[activities.indexOf(existing)] = row;
        else activities.push(row);
        return structuredClone(row);
      });
    },
    async getActivityStreams(activityId) {
      return streams
        .filter((s) => s.activityId === activityId)
        .sort((a, b) => compareText(a.channel, b.channel))
        .map((s) => structuredClone(s));
    },
    async replaceActivityStreams(activityId, input) {
      // activity_id references external_activities(id): mirror the FK.
      if (!activities.some((a) => a.id === activityId)) throw new Error(`External activity ${activityId} not found`);
      // Replace: channels absent from the new set are dropped, as supabase.ts deletes them.
      const keep = new Set(input.map((s) => s.channel));
      for (let i = streams.length - 1; i >= 0; i--) {
        if (streams[i].activityId === activityId && !keep.has(streams[i].channel)) streams.splice(i, 1);
      }
      for (const s of input) {
        const row: ActivityStream = { activityId, channel: s.channel, startOffsetS: s.startOffsetS ?? 0, values: s.values.slice() };
        const idx = streams.findIndex((x) => x.activityId === activityId && x.channel === s.channel);
        if (idx === -1) streams.push(row);
        else streams[idx] = row;
      }
    },
    async listBodyWeights(from, to) {
      return bodyWeights
        .filter((w) => instant(w.measuredAt) >= instant(from) && instant(w.measuredAt) <= instant(to))
        .sort((a, b) => byInstant(a.measuredAt, b.measuredAt))
        .map((w) => ({ ...w }));
    },
    async upsertBodyWeights(rows) {
      for (const w of rows) {
        const existing = bodyWeights.find((x) => x.source === w.source && x.sourceId === w.sourceId);
        const row: BodyWeight = {
          id: existing?.id ?? nextId("bw"),
          source: w.source,
          sourceId: w.sourceId,
          measuredAt: w.measuredAt,
          weightKg: w.weightKg,
          bmi: w.bmi ?? null,
          bodyFatPct: w.bodyFatPct ?? null,
          bodyWaterPct: w.bodyWaterPct ?? null,
          muscleMassKg: w.muscleMassKg ?? null,
          boneMassKg: w.boneMassKg ?? null,
        };
        if (existing) bodyWeights[bodyWeights.indexOf(existing)] = row;
        else bodyWeights.push(row);
      }
    },
    async getAthleteSettings() {
      return { ...(athleteSettings ?? DEFAULT_ATHLETE_SETTINGS) };
    },
    async saveAthleteSettings(patch) {
      const next: AthleteSettings = { ...(athleteSettings ?? DEFAULT_ATHLETE_SETTINGS) };
      for (const [key, value] of Object.entries(patch) as [keyof AthleteSettings, never][]) {
        if (value !== undefined) next[key] = value;
      }
      athleteSettings = next;
      return { ...next };
    },
    async listFtpHistory() {
      // Stable sort keeps insertion (created_at) order among equal effectiveFrom.
      return ftpHistory
        .slice()
        .sort((a, b) => byInstant(a.effectiveFrom, b.effectiveFrom))
        .map((e) => ({ ...e }));
    },
    async addFtpHistoryEntry(entry) {
      if (!(Number.isInteger(entry.ftpW) && entry.ftpW > 0)) throw new Error(`ftpW must be a positive integer, got ${entry.ftpW}`);
      if (ftpHistory.some((e) => instant(e.effectiveFrom) === instant(entry.effectiveFrom) && e.source === entry.source)) {
        throw new Error(`An FTP entry from ${entry.source} at ${entry.effectiveFrom} already exists`);
      }
      const row: FtpHistoryEntry = { id: nextId("ftp"), effectiveFrom: entry.effectiveFrom, ftpW: entry.ftpW, source: entry.source, sourceRef: entry.sourceRef ?? null };
      ftpHistory.push(row);
      return { ...row };
    },
    async listDailyTrainingLoad(from, to) {
      return [...trainingLoad.values()]
        .filter((d) => d.date >= from && d.date <= to)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
        .map((d) => structuredClone(d));
    },
    async upsertDailyTrainingLoad(rows) {
      for (const d of rows) trainingLoad.set(d.date, structuredClone(d));
    },
    async listSyncState() {
      // Only the service-role sync writes sync_state; the mock has no sync.
      return [];
    },
  };
}
