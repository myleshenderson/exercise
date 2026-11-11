/**
 * The Starkeep DataLayer: the app's own tables behind Starkeep's row API
 * (`/app-data/db/<table>`), reached through a {@link Transport}. In the
 * browser that is the app server's signing proxy (`browserTransport`); the
 * MCP handlers can pass a server-side transport instead.
 *
 * Semantics follow `src/data/supabase.ts` method for method. What the
 * Postgres schema did for free is done here by hand (starkeep/README.md
 * "Table mapping"):
 * - Ids come from `crypto.randomUUID()` and `created_at`/`recorded_at` from
 *   `new Date().toISOString()`; the server assigns neither.
 * - `target_sets` is a JSON string in a `text` column.
 * - Soft delete is the app column `archived_at`; reads filter it themselves.
 * - Foreign-key cascades (deleteSession → session_sets) are explicit deletes.
 * - Joins happen in memory after fetching rows bounded by the method's own
 *   filters, and every list uses `selectAll` so nothing is cut at 500 rows.
 * - First-use seeding is guarded by a row in the Starkeep-only `app_meta`
 *   table instead of Supabase's `seed_claims`.
 *
 * No `user_id` anywhere: Starkeep scopes rows to the caller underneath the
 * row API.
 */
import { DEFAULT_ATHLETE_SETTINGS, type DataLayer, type DayLookup } from "./DataLayer.js";
import type { Exercise, Program, Session, SetEntry, WorkoutDay } from "../types.js";
import { nextAvailablePositionByProgram, isDayAvailable } from "../lib/programAvailability.js";
import { compareText } from "../analysis/sqlSemantics.js";
import { createRowClient, type Row, type RowClient, type Transport, type Where } from "./starkeep/rows.js";

interface ExerciseRow {
  [key: string]: unknown;
  id: string;
  name: string;
  cue: string;
  default_sets: number;
  default_rep_low: number;
  default_rep_high: number;
  created_at: string;
  archived_at: string | null;
}

interface ProgramRow {
  [key: string]: unknown;
  id: string;
  name: string;
  created_at: string;
  archived_at: string | null;
}

interface DayRow {
  [key: string]: unknown;
  id: string;
  name: string;
  position: number;
  program_id: string | null;
  program_position: number | null;
  created_at: string;
  archived_at: string | null;
}

interface LinkRow {
  [key: string]: unknown;
  id: string;
  workout_day_id: string;
  exercise_id: string;
  position: number;
  target_sets: string | null;
}

interface SchemeHistoryRow {
  [key: string]: unknown;
  id: string;
  workout_day_id: string;
  exercise_id: string;
  target_sets: string | null;
  recorded_at: string;
}

interface SessionRow {
  [key: string]: unknown;
  id: string;
  workout_day_id: string | null;
  performed_on: string;
  created_at: string;
}

interface SetRow {
  [key: string]: unknown;
  id: string;
  session_id: string;
  exercise_id: string;
  set_number: number;
  weight: number;
  reps: number;
}

const T = {
  programs: "programs",
  exercises: "exercises",
  days: "workout_days",
  links: "workout_day_exercises",
  history: "workout_day_exercise_scheme_history",
  sessions: "sessions",
  sets: "session_sets",
  meta: "app_meta",
} as const;

/**
 * `app_meta.id` prefix of first-use seeding claims: each claimant writes
 * `seed_claim:<uuid>`. See claimSeed.
 */
export const SEED_CLAIM_PREFIX = "seed_claim:";

/** How long a claimant waits for concurrent claims to land before deciding. */
const DEFAULT_CLAIM_SETTLE_MS = 300;

export interface StarkeepDataLayerOptions {
  /** claimSeed's settle delay; tests pass 0. */
  claimSettleMs?: number;
}

/** Ids per `in` filter, to keep each query string well under URL limits. */
const IN_CHUNK = 100;

const LIVE = { archived_at: null } as const;

/** Thrown by deleteExercise while something still references the exercise. */
export class ExerciseInUseError extends Error {
  readonly usage: "day" | "history";
  constructor(exerciseId: string, usage: "day" | "history") {
    super(
      usage === "day"
        ? `Exercise ${exerciseId} is attached to one or more days; remove it from them first.`
        : `Exercise ${exerciseId} has logged sets or scheme history and cannot be deleted.`,
    );
    this.name = "ExerciseInUseError";
    this.usage = usage;
  }
}

const toExercise = (r: ExerciseRow): Exercise => ({
  id: r.id,
  name: r.name,
  cue: r.cue,
  defaultSets: r.default_sets,
  defaultRepLow: r.default_rep_low,
  defaultRepHigh: r.default_rep_high,
});

const toSetEntry = (r: SetRow): SetEntry => ({ setNumber: r.set_number, weight: Number(r.weight), reps: r.reps });

/** Parse a `target_sets` JSON string into 1-numbered SetEntries; null/empty → null. */
function parseTargetSets(raw: string | null): SetEntry[] | null {
  if (raw === null || raw === undefined) return null;
  const parsed = JSON.parse(raw) as { weight: number; reps: number }[] | null;
  if (!parsed || parsed.length === 0) return null;
  return parsed.map((s, i) => ({ setNumber: i + 1, weight: s.weight, reps: s.reps }));
}

function chunks<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * selectAll with `column in ids`, chunked to {@link IN_CHUNK} ids per request;
 * rows from every chunk, in chunk order, otherwise unsorted. Null/undefined ids
 * and duplicates are dropped, and no ids means no request at all. Shared by
 * this DataLayer and starkeep/handlers.ts.
 */
export async function selectIn<R extends Row>(
  rows: RowClient,
  table: string,
  column: string,
  ids: readonly (string | null | undefined)[],
  opts: { where?: Where; select?: string[]; order?: string[] } = {},
): Promise<R[]> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  const out: R[] = [];
  for (const part of chunks(unique)) {
    out.push(...(await rows.selectAll<R>(table, { ...opts, where: { ...opts.where, [column]: { in: part } } })));
  }
  return out;
}

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

/** `performed_on desc, created_at desc` — supabase.ts's session ordering. */
function newestFirst(a: SessionRow, b: SessionRow): number {
  if (a.performed_on !== b.performed_on) return a.performed_on < b.performed_on ? 1 : -1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return 0;
}

/** What every ride analytics write rejects with until Starkeep declares the tables. */
export const RIDE_ANALYTICS_UNAVAILABLE = "ride analytics is not available on Starkeep yet";

/**
 * Ride analytics (AI-631) is not declared in starkeep.manifest.json yet
 * (decision 3: Starkeep parity is a later issue). Reads answer "nothing
 * stored" and writes reject, both without touching the transport.
 */
const rideAnalyticsStub: Pick<
  DataLayer,
  | "listExternalActivities" | "getExternalActivity" | "upsertExternalActivities" | "getActivityStreams"
  | "replaceActivityStreams" | "listBodyWeights" | "upsertBodyWeights" | "getAthleteSettings"
  | "saveAthleteSettings" | "listFtpHistory" | "addFtpHistoryEntry" | "listDailyTrainingLoad"
  | "upsertDailyTrainingLoad" | "listSyncState"
> = {
  listExternalActivities: async () => [],
  getExternalActivity: async () => null,
  getActivityStreams: async () => [],
  listBodyWeights: async () => [],
  getAthleteSettings: async () => ({ ...DEFAULT_ATHLETE_SETTINGS }),
  listFtpHistory: async () => [],
  listDailyTrainingLoad: async () => [],
  listSyncState: async () => [],
  upsertExternalActivities: async () => Promise.reject(new Error(RIDE_ANALYTICS_UNAVAILABLE)),
  replaceActivityStreams: async () => Promise.reject(new Error(RIDE_ANALYTICS_UNAVAILABLE)),
  upsertBodyWeights: async () => Promise.reject(new Error(RIDE_ANALYTICS_UNAVAILABLE)),
  saveAthleteSettings: async () => Promise.reject(new Error(RIDE_ANALYTICS_UNAVAILABLE)),
  addFtpHistoryEntry: async () => Promise.reject(new Error(RIDE_ANALYTICS_UNAVAILABLE)),
  upsertDailyTrainingLoad: async () => Promise.reject(new Error(RIDE_ANALYTICS_UNAVAILABLE)),
};

export function createStarkeepDataLayer(transport: Transport, opts: StarkeepDataLayerOptions = {}): DataLayer {
  return createStarkeepDataLayerFromRows(createRowClient(transport), opts);
}

export function createStarkeepDataLayerFromRows(rows: RowClient, opts: StarkeepDataLayerOptions = {}): DataLayer {
  const claimSettleMs = opts.claimSettleMs ?? DEFAULT_CLAIM_SETTLE_MS;

  async function first<R extends Row>(table: string, where: Where, order: string[] = []): Promise<R | null> {
    const { rows: found } = await rows.select<R>(table, { where, order, limit: 1 });
    return found[0] ?? null;
  }

  /**
   * Replace a set of rows (supabase.ts: delete, then one bulk insert). The row
   * API has no transaction and no bulk insert, so insert the new rows first
   * and delete the old ones by id last: a failure part-way leaves the old rows
   * intact (any new rows already written are removed again) rather than
   * losing them.
   */
  async function replaceRows(table: string, oldIds: string[], newRows: Row[]): Promise<void> {
    const written: string[] = [];
    try {
      for (const row of newRows) {
        await rows.insert(table, row);
        written.push(row.id as string);
      }
    } catch (err) {
      for (const part of chunks(written)) await rows.remove(table, { id: { in: part } }).catch(() => 0);
      throw err;
    }
    for (const part of chunks(oldIds)) await rows.remove(table, { id: { in: part } });
  }

  async function fetchExercise(id: string): Promise<Exercise | null> {
    const row = await first<ExerciseRow>(T.exercises, { id });
    return row ? toExercise(row) : null;
  }

  /** Sessions with their sets, in the order of `sessionRows`. */
  async function hydrate(sessionRows: SessionRow[], allSets?: SetRow[]): Promise<Session[]> {
    if (sessionRows.length === 0) return [];
    const sets = allSets ?? (await selectIn<SetRow>(rows, T.sets, "session_id", sessionRows.map((s) => s.id)));
    const bySession = new Map<string, SetRow[]>();
    for (const s of sets) {
      const list = bySession.get(s.session_id);
      if (list) list.push(s);
      else bySession.set(s.session_id, [s]);
    }
    return sessionRows.map((s) => {
      // supabase.ts: sets ordered by set_number, grouped by exercise in first-appearance order.
      const ordered = (bySession.get(s.id) ?? []).slice().sort((a, b) => a.set_number - b.set_number);
      const byExercise = new Map<string, SetEntry[]>();
      for (const row of ordered) {
        const list = byExercise.get(row.exercise_id);
        if (list) list.push(toSetEntry(row));
        else byExercise.set(row.exercise_id, [toSetEntry(row)]);
      }
      return {
        id: s.id,
        workoutDayId: s.workout_day_id,
        performedOn: s.performed_on,
        exercises: [...byExercise.entries()].map(([exerciseId, exSets]) => ({ exerciseId, sets: exSets })),
      };
    });
  }

  async function loadSession(id: string): Promise<Session | null> {
    const s = await first<SessionRow>(T.sessions, { id });
    if (!s) return null;
    const sets = await rows.selectAll<SetRow>(T.sets, { where: { session_id: id }, order: ["set_number.asc"] });
    return (await hydrate([s], sets))[0];
  }

  /** The day's exercise links, ordered by position. */
  async function dayLinks(dayId: string): Promise<LinkRow[]> {
    return rows.selectAll<LinkRow>(T.links, { where: { workout_day_id: dayId }, order: ["position.asc"] });
  }

  async function exerciseUsage(exerciseId: string): Promise<"day" | "history" | null> {
    if (await first(T.links, { exercise_id: exerciseId })) return "day";
    if (await first(T.sets, { exercise_id: exerciseId })) return "history";
    if (await first(T.history, { exercise_id: exerciseId })) return "history";
    return null;
  }

  return {
    async claimSeed() {
      // supabase.ts relies on seed_claims' primary key: a second insert fails.
      // Starkeep's insert is a last-writer-wins upsert, so one shared claim
      // row cannot pick a winner. Instead every claimant adds its own row and,
      // once concurrent claims have had time to land, the lowest id wins:
      // - Any claim already present → someone else claimed; don't seed.
      // - Otherwise add ours, wait, and seed only if ours sorts first among
      //   all claims. Claimants that both got past the check see the same
      //   set and agree; only one landing more than the settle time after
      //   the other's read could make both win.
      const claims = () =>
        rows.selectAll<{ id: string }>(T.meta, { where: { id: { prefix: SEED_CLAIM_PREFIX } }, select: ["id"] });
      if ((await claims()).length > 0) return false;
      const mine = `${SEED_CLAIM_PREFIX}${newId()}`;
      try {
        await rows.insert(T.meta, { id: mine, value: now() });
      } catch (err) {
        // The write may have landed even though the response failed.
        if (!(await first(T.meta, { id: mine }))) throw err;
      }
      if (claimSettleMs > 0) await new Promise((resolve) => setTimeout(resolve, claimSettleMs));
      const all = (await claims()).map((c) => c.id).sort();
      return all[0] === mine;
    },

    async listExercises() {
      const found = await rows.selectAll<ExerciseRow>(T.exercises, { where: LIVE, order: ["name.asc"] });
      // supabase.ts orders by name in the database's en_US collation; the row
      // API's `name.asc` is the data plane's byte order. Re-sort with the
      // analysis port of that collation (stable, so equal names keep the row
      // API's order) so the UI and list_exercises match Supabase.
      return found.sort((a, b) => compareText(a.name, b.name)).map(toExercise);
    },
    getExercise: (id) => fetchExercise(id),
    async createExercise(input) {
      const row: ExerciseRow = {
        id: newId(),
        name: input.name,
        cue: input.cue,
        default_sets: input.defaultSets,
        default_rep_low: input.defaultRepLow,
        default_rep_high: input.defaultRepHigh,
        created_at: now(),
        archived_at: null,
      };
      await rows.insert(T.exercises, row);
      return toExercise(row);
    },
    async updateExercise(id, patch) {
      const dbPatch: Record<string, unknown> = {};
      if (patch.name !== undefined) dbPatch.name = patch.name;
      if (patch.cue !== undefined) dbPatch.cue = patch.cue;
      if (patch.defaultSets !== undefined) dbPatch.default_sets = patch.defaultSets;
      if (patch.defaultRepLow !== undefined) dbPatch.default_rep_low = patch.defaultRepLow;
      if (patch.defaultRepHigh !== undefined) dbPatch.default_rep_high = patch.defaultRepHigh;
      if (Object.keys(dbPatch).length > 0) await rows.patch(T.exercises, { id }, dbPatch);
      // supabase.ts's `.single()` throws when no row matched; so does this.
      const updated = await fetchExercise(id);
      if (!updated) throw new Error(`Exercise ${id} not found`);
      return updated;
    },
    async deleteExercise(id) {
      const usage = await exerciseUsage(id);
      if (usage) throw new ExerciseInUseError(id, usage);
      await rows.patch(T.exercises, { id }, { archived_at: now() });
    },

    async findDayByName(name): Promise<DayLookup | null> {
      const d = await first<DayRow>(T.days, { name, archived_at: null }, ["created_at.asc"]);
      return d
        ? { id: d.id, name: d.name, position: d.position, programId: d.program_id, programPosition: d.program_position }
        : null;
    },
    async findExerciseByName(name) {
      const e = await first<ExerciseRow>(T.exercises, { name, archived_at: null }, ["created_at.asc"]);
      return e ? toExercise(e) : null;
    },
    async findProgramByName(name) {
      const p = await first<ProgramRow>(T.programs, { name, archived_at: null }, ["created_at.asc"]);
      return p ? { id: p.id, name: p.name } : null;
    },

    async getWorkoutDays() {
      // created_at breaks position ties (every createDay starts at 0, as in
      // Postgres) so the order is stable rather than by random uuid.
      const dayRows = await rows.selectAll<DayRow>(T.days, { where: LIVE, order: ["position.asc", "created_at.asc"] });
      if (dayRows.length === 0) return [];
      const programRows = await rows.selectAll<ProgramRow>(T.programs, { where: LIVE, select: ["id", "name"] });
      const programsById = new Map(programRows.map((p) => [p.id, p.name]));

      const availabilityInput = dayRows.map((d) => ({
        id: d.id,
        programId: d.program_id && programsById.has(d.program_id) ? d.program_id : null,
        programPosition: d.program_position,
      }));

      // supabase.ts: sessions inner-joined to session_sets → days with at least
      // one non-empty session. Only programmed days use it, so only those are asked.
      const programmedDayIds = availabilityInput.filter((d) => d.programId !== null).map((d) => d.id);
      const completed = new Set<string>();
      if (programmedDayIds.length > 0) {
        const sessionRows = await selectIn<SessionRow>(rows, T.sessions, "workout_day_id", programmedDayIds, {
          select: ["id", "workout_day_id"],
        });
        const dayBySession = new Map(sessionRows.map((s) => [s.id, s.workout_day_id as string]));
        for (const part of chunks([...dayBySession.keys()])) {
          const { groups } = await rows.aggregate<{ session_id: string }>(T.sets, {
            where: { session_id: { in: part } },
            groupBy: ["session_id"],
            aggregate: { n: { fn: "count" } },
            limit: IN_CHUNK,
          });
          for (const g of groups) completed.add(dayBySession.get(g.session_id)!);
        }
      }
      const nextByProgram = nextAvailablePositionByProgram(availabilityInput, completed);

      const links = await selectIn<LinkRow>(rows, T.links, "workout_day_id", dayRows.map((d) => d.id), {
        select: ["workout_day_id", "exercise_id", "position"],
      });
      const linksByDay = new Map<string, LinkRow[]>();
      for (const l of links) {
        const list = linksByDay.get(l.workout_day_id);
        if (list) list.push(l);
        else linksByDay.set(l.workout_day_id, [l]);
      }

      return dayRows.map((d, i): WorkoutDay => {
        const effective = availabilityInput[i];
        const dayLinkRows = (linksByDay.get(d.id) ?? []).slice().sort((a, b) => a.position - b.position);
        return {
          id: d.id,
          name: d.name,
          position: d.position,
          exerciseIds: dayLinkRows.map((l) => l.exercise_id),
          programId: effective.programId,
          programPosition: effective.programId ? d.program_position : null,
          programName: effective.programId ? programsById.get(effective.programId)! : null,
          isAvailable: isDayAvailable(effective, nextByProgram),
        };
      });
    },
    async getDayExercises(dayId) {
      const links = await dayLinks(dayId);
      const found = await selectIn<ExerciseRow>(rows, T.exercises, "id", links.map((l) => l.exercise_id));
      const byId = new Map(found.map((e) => [e.id, toExercise(e)]));
      return links.map((l) => byId.get(l.exercise_id)).filter((e): e is Exercise => !!e);
    },
    async createDay(name) {
      const row: DayRow = {
        id: newId(),
        name,
        position: 0, // Postgres `default 0`; supabase.ts inserts only the name.
        program_id: null,
        program_position: null,
        created_at: now(),
        archived_at: null,
      };
      await rows.insert(T.days, row);
      return {
        id: row.id, name: row.name, position: row.position, exerciseIds: [],
        programId: null, programPosition: null, programName: null, isAvailable: true,
      };
    },
    async deleteDay(id) {
      await rows.patch(T.days, { id }, { archived_at: now() });
    },
    async addExerciseToDay(dayId, exerciseId) {
      const last = await first<LinkRow>(T.links, { workout_day_id: dayId }, ["position.desc"]);
      const nextPosition = last ? last.position + 1 : 0;
      await rows.insert(T.links, {
        id: newId(),
        workout_day_id: dayId,
        exercise_id: exerciseId,
        position: nextPosition,
        target_sets: null,
      });
    },
    async removeExerciseFromDay(dayId, exerciseId) {
      await rows.remove(T.links, { workout_day_id: dayId, exercise_id: exerciseId });
    },
    async updateDayExercises(dayId, exerciseIds) {
      const existing = await dayLinks(dayId);
      const targetsByExercise = new Map<string, string>();
      for (const row of existing) {
        if (row.target_sets) targetsByExercise.set(row.exercise_id, row.target_sets);
      }
      await replaceRows(
        T.links,
        existing.map((l) => l.id),
        exerciseIds.map((exercise_id, position) => ({
          id: newId(),
          workout_day_id: dayId,
          exercise_id,
          position,
          target_sets: targetsByExercise.get(exercise_id) ?? null,
        })),
      );
    },
    async updateDayName(dayId, name) {
      await rows.patch(T.days, { id: dayId }, { name });
    },
    async createProgram(name) {
      const id = newId();
      await rows.insert(T.programs, { id, name, created_at: now(), archived_at: null });
      return { id, name } satisfies Program;
    },
    async renameProgram(programId, name) {
      await rows.patch(T.programs, { id: programId }, { name });
    },
    async deleteProgram(programId) {
      await rows.patch(T.programs, { id: programId }, { archived_at: now() });
    },
    async addDayToProgram(dayId, programId) {
      const last = await first<DayRow>(T.days, { program_id: programId }, ["program_position.desc.nullslast"]);
      const nextPosition = last && last.program_position !== null ? last.program_position + 1 : 0;
      await rows.patch(T.days, { id: dayId }, { program_id: programId, program_position: nextPosition });
    },
    async removeDayFromProgram(dayId) {
      await rows.patch(T.days, { id: dayId }, { program_id: null, program_position: null });
    },
    async reorderProgramDays(programId, dayIds) {
      // supabase.ts parks rows at negative positions first to dodge the
      // partial unique index mid-reorder. Starkeep has no such index, so one
      // pass of per-row updates reaches the same end state.
      for (const [index, dayId] of dayIds.entries()) {
        await rows.patch(T.days, { id: dayId, program_id: programId }, { program_position: index });
      }
    },
    async getDayExerciseTargets(dayId) {
      const links = await rows.selectAll<LinkRow>(T.links, {
        where: { workout_day_id: dayId },
        select: ["exercise_id", "target_sets"],
      });
      const out: Record<string, SetEntry[]> = {};
      for (const row of links) {
        const sets = parseTargetSets(row.target_sets);
        if (sets) out[row.exercise_id] = sets;
      }
      return out;
    },
    async setDayExerciseTarget(dayId, exerciseId, sets) {
      const target_sets =
        sets && sets.length > 0 ? JSON.stringify(sets.map((s) => ({ weight: s.weight, reps: s.reps }))) : null;
      await rows.patch(T.links, { workout_day_id: dayId, exercise_id: exerciseId }, { target_sets });
      await rows.insert(T.history, {
        id: newId(),
        workout_day_id: dayId,
        exercise_id: exerciseId,
        target_sets,
        recorded_at: now(),
      });
    },
    async getSchemeHistory(dayId, exerciseId) {
      const found = await rows.selectAll<SchemeHistoryRow>(T.history, {
        where: { workout_day_id: dayId, exercise_id: exerciseId },
        select: ["id", "target_sets", "recorded_at"],
        order: ["recorded_at.asc"],
      });
      return found.map((row) => ({ targetSets: parseTargetSets(row.target_sets), recordedAt: row.recorded_at }));
    },

    async getLastSetsForExercise(exerciseId, beforeDate) {
      // supabase.ts walks every earlier session newest-first and probes each
      // for this exercise's sets. Same answer, bounded by the exercise: its
      // sets, then their sessions before the date, newest first.
      const sets = await rows.selectAll<SetRow>(T.sets, { where: { exercise_id: exerciseId } });
      if (sets.length === 0) return [];
      const sessionRows = await selectIn<SessionRow>(rows, T.sessions, "id", sets.map((s) => s.session_id), {
        where: { performed_on: { lt: beforeDate } },
      });
      const newest = sessionRows.sort(newestFirst)[0];
      if (!newest) return [];
      return sets
        .filter((s) => s.session_id === newest.id)
        .sort((a, b) => a.set_number - b.set_number)
        .map(toSetEntry);
    },
    async startSession(workoutDayId, date) {
      const row: SessionRow = { id: newId(), workout_day_id: workoutDayId, performed_on: date, created_at: now() };
      await rows.insert(T.sessions, row);
      return { id: row.id, workoutDayId: row.workout_day_id, performedOn: row.performed_on, exercises: [] };
    },
    getSession: (id) => loadSession(id),
    async getLastSessionForDay(workoutDayId) {
      const sessionRows = await rows.selectAll<SessionRow>(T.sessions, {
        where: { workout_day_id: workoutDayId },
        order: ["performed_on.desc", "created_at.desc"],
      });
      // supabase.ts loads sessions one by one until a non-empty one; here the
      // day's sets come in one batch and the same first non-empty wins.
      const sessions = await hydrate(sessionRows);
      return sessions.find((s) => s.exercises.length > 0) ?? null;
    },
    async getSessionForDayAndDate(workoutDayId, date) {
      const s = await first<SessionRow>(T.sessions, { workout_day_id: workoutDayId, performed_on: date }, [
        "created_at.desc",
      ]);
      return s ? loadSession(s.id) : null;
    },
    async logExercise(sessionId, exerciseId, sets) {
      const existing = await rows.selectAll<{ id: string }>(T.sets, {
        where: { session_id: sessionId, exercise_id: exerciseId },
        select: ["id"],
      });
      await replaceRows(
        T.sets,
        existing.map((r) => r.id),
        sets.map((s) => ({
          id: newId(),
          session_id: sessionId,
          exercise_id: exerciseId,
          set_number: s.setNumber,
          weight: s.weight,
          reps: s.reps,
        })),
      );
    },
    async getExerciseHistory(exerciseId) {
      const setRows = await rows.selectAll<SetRow>(T.sets, { where: { exercise_id: exerciseId }, select: ["session_id"] });
      const ids = [...new Set(setRows.map((r) => r.session_id))];
      const sessionRows = await selectIn<SessionRow>(rows, T.sessions, "id", ids);
      const byId = new Map(sessionRows.map((s) => [s.id, s]));
      const ordered = ids.map((id) => byId.get(id)).filter((s): s is SessionRow => !!s);
      const sessions = await hydrate(ordered);
      return sessions.sort((a, b) => (a.performedOn < b.performedOn ? 1 : -1));
    },
    async listSessions() {
      const sessionRows = await rows.selectAll<SessionRow>(T.sessions, {
        order: ["performed_on.desc", "created_at.desc"],
      });
      if (sessionRows.length === 0) return [];
      // Every session is wanted, so every set is: one paged scan, not N probes.
      const allSets = await rows.selectAll<SetRow>(T.sets, {});
      return hydrate(sessionRows, allSets);
    },
    async deleteSession(id) {
      // Postgres cascaded session_sets; Starkeep has no foreign keys.
      await rows.remove(T.sets, { session_id: id });
      await rows.remove(T.sessions, { id });
    },
    ...rideAnalyticsStub,
  };
}
