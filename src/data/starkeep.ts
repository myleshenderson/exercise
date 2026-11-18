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
 *   `new Date().toISOString()`; the server assigns neither. Starter rows are
 *   the exception: their ids are fixed (`./starkeep/starterIds.ts`).
 * - `target_sets` is a JSON string in a `text` column.
 * - Soft delete is the app column `archived_at`; reads filter it themselves.
 * - Foreign-key cascades (deleteSession → session_sets) are explicit deletes.
 * - Every PATCH and DELETE names one row by its `id`, because the row API
 *   refuses a `where` that does not name the whole primary key as plain
 *   values. A write to several rows selects their ids first and writes each.
 *   A write to a row that is not there is not an error, as an update
 *   matching no row is not in Postgres; `updateExercise` alone reports it.
 * - Joins happen in memory after fetching rows bounded by the method's own
 *   filters, and every list uses `selectAll` so nothing is cut at 500 rows.
 * - First-use seeding writes the starter rows under fixed ids with `ifAbsent`,
 *   instead of claiming the seed as Supabase's `seed_claims` does.
 *
 * - Ride analytics (AI-822) lives in `./starkeep/rideAnalytics.ts`, over the
 *   ids and row mappers of `./starkeep/rideRows.ts`.
 *
 * No `user_id` anywhere: Starkeep scopes rows to the caller underneath the
 * row API.
 */
import type { DataLayer, DayLookup } from "./DataLayer.js";
import type { Exercise, Program, Session, SetEntry, WorkoutDay } from "../types.js";
import { nextAvailablePositionByProgram, isDayAvailable } from "../lib/programAvailability.js";
import { compareText } from "../analysis/sqlSemantics.js";
import { createRowClient, type Row, type RowClient, type Transport, type Where } from "./starkeep/rows.js";
import { chunks, IN_CHUNK, selectIn } from "./starkeep/select.js";
import { createRideAnalytics } from "./starkeep/rideAnalytics.js";
import { seedDays, seedExercises } from "./seed.js";
import { starterDayId, starterExerciseId, starterLinkId } from "./starkeep/starterIds.js";

/** Shared with starkeep/handlers.ts. */
export { selectIn };

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
} as const;

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

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

/** `performed_on desc, created_at desc` — supabase.ts's session ordering. */
function newestFirst(a: SessionRow, b: SessionRow): number {
  if (a.performed_on !== b.performed_on) return a.performed_on < b.performed_on ? 1 : -1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return 0;
}

export function createStarkeepDataLayer(transport: Transport): DataLayer {
  return createStarkeepDataLayerFromRows(createRowClient(transport));
}

export function createStarkeepDataLayerFromRows(rows: RowClient): DataLayer {
  async function first<R extends Row>(table: string, where: Where, order: string[] = []): Promise<R | null> {
    const { rows: found } = await rows.select<R>(table, { where, order, limit: 1 });
    return found[0] ?? null;
  }

  /** Delete each row by its id: the row API deletes one keyed row per request. */
  async function removeEach(table: string, ids: string[]): Promise<void> {
    for (const id of ids) await rows.remove(table, { id });
  }

  /** The ids of the rows matching `where`. */
  async function idsWhere(table: string, where: Where): Promise<string[]> {
    return (await rows.selectAll<{ id: string }>(table, { where, select: ["id"] })).map((r) => r.id);
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
      for (const id of written) await rows.remove(table, { id }).catch(() => undefined);
      throw err;
    }
    await removeEach(table, oldIds);
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
    async seedStarterData() {
      // One read decides. A day that is not a starter day means the user has
      // their own data, such as a user seeded before starter ids were fixed;
      // every starter day present, live or archived, means the seed finished.
      // Otherwise write whatever is missing: `ifAbsent` leaves alone a row
      // another surface or tab already wrote, and a row the user deleted.
      const starterDays = await Promise.all(seedDays.map((d) => starterDayId(d.id)));
      const dayIds = new Set((await rows.selectAll<{ id: string }>(T.days, { select: ["id"] })).map((r) => r.id));
      if ([...dayIds].some((id) => !starterDays.includes(id))) return;
      if (starterDays.every((id) => dayIds.has(id))) return;

      const at = now();
      const exerciseIds = new Map<string, string>();
      for (const e of seedExercises) {
        const id = await starterExerciseId(e.id);
        exerciseIds.set(e.id, id);
        const row: ExerciseRow = {
          id,
          name: e.name,
          cue: e.cue,
          default_sets: e.defaultSets,
          default_rep_low: e.defaultRepLow,
          default_rep_high: e.defaultRepHigh,
          created_at: at,
          archived_at: null,
        };
        await rows.insert(T.exercises, row, { ifAbsent: true });
      }
      // Each day's links before the day: the day row is what marks it done.
      for (const [index, d] of seedDays.entries()) {
        for (const [position, slug] of d.exerciseIds.entries()) {
          const link: LinkRow = {
            id: await starterLinkId(d.id, slug),
            workout_day_id: starterDays[index],
            exercise_id: exerciseIds.get(slug)!,
            position,
            target_sets: null,
          };
          await rows.insert(T.links, link, { ifAbsent: true });
        }
        const day: DayRow = {
          id: starterDays[index],
          name: d.name,
          position: d.position,
          program_id: null,
          program_position: null,
          created_at: at,
          archived_at: null,
        };
        await rows.insert(T.days, day, { ifAbsent: true });
      }
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
      // supabase.ts's `.single()` throws when no row matched; so does this,
      // whether the row is gone before the read or before the patch.
      const current = await fetchExercise(id);
      if (!current) throw new Error(`Exercise ${id} not found`);
      if (Object.keys(dbPatch).length === 0) return current;
      const { skipped } = await rows.patch(T.exercises, { id }, dbPatch);
      if (skipped === "missing") throw new Error(`Exercise ${id} not found`);
      return {
        ...current,
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.cue !== undefined && { cue: patch.cue }),
        ...(patch.defaultSets !== undefined && { defaultSets: patch.defaultSets }),
        ...(patch.defaultRepLow !== undefined && { defaultRepLow: patch.defaultRepLow }),
        ...(patch.defaultRepHigh !== undefined && { defaultRepHigh: patch.defaultRepHigh }),
      };
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
      await removeEach(T.links, await idsWhere(T.links, { workout_day_id: dayId, exercise_id: exerciseId }));
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
      for (const id of await idsWhere(T.links, { workout_day_id: dayId, exercise_id: exerciseId })) {
        await rows.patch(T.links, { id }, { target_sets });
      }
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
      await removeEach(T.sets, await idsWhere(T.sets, { session_id: id }));
      await rows.remove(T.sessions, { id });
    },
    ...createRideAnalytics(rows),
  };
}
