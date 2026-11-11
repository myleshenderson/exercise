import type { DataLayer } from "./DataLayer";
import { createMockDataLayer } from "./mock";
import { createStarkeepDataLayer } from "./starkeep";
import { browserTransport } from "./starkeep/browserTransport";

// Every DataLayer method, so the lazy wrapper below cannot miss one: adding a
// method to the interface without listing it here is a type error.
const METHODS: Record<keyof DataLayer, true> = {
  listExercises: true, getExercise: true, createExercise: true, updateExercise: true, deleteExercise: true,
  findDayByName: true, findExerciseByName: true, findProgramByName: true, claimSeed: true,
  getWorkoutDays: true, getDayExercises: true, createDay: true, deleteDay: true, addExerciseToDay: true,
  removeExerciseFromDay: true, updateDayExercises: true, updateDayName: true, createProgram: true,
  renameProgram: true, deleteProgram: true, addDayToProgram: true, removeDayFromProgram: true,
  reorderProgramDays: true, getDayExerciseTargets: true, setDayExerciseTarget: true, getSchemeHistory: true,
  getLastSetsForExercise: true, startSession: true, getSession: true, getLastSessionForDay: true,
  getSessionForDayAndDate: true, logExercise: true, getExerciseHistory: true, listSessions: true,
  deleteSession: true,
  listExternalActivities: true, getExternalActivity: true, upsertExternalActivities: true, getActivityStreams: true,
  replaceActivityStreams: true, listBodyWeights: true, upsertBodyWeights: true, getAthleteSettings: true,
  saveAthleteSettings: true, listFtpHistory: true, addFtpHistoryEntry: true, listDailyTrainingLoad: true,
  upsertDailyTrainingLoad: true, listSyncState: true,
};

// Supabase is loaded with a dynamic import() on first use, so a mock or
// Starkeep build never pulls supabase-js into its module graph (see
// index.test.ts). Every DataLayer method is async, so forwarding is invisible.
function lazySupabase(): DataLayer {
  let loaded: Promise<DataLayer> | undefined;
  const load = () =>
    (loaded ??= import("./supabase")
      .then((m) => m.createSupabaseDataLayer())
      .catch((err: unknown) => {
        loaded = undefined; // a failed chunk load is retried on the next call
        throw err;
      }));
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(METHODS) as (keyof DataLayer)[]) {
    out[name] = async (...args: unknown[]) => {
      const real = await load();
      return (real[name] as (...a: unknown[]) => Promise<unknown>)(...args);
    };
  }
  return out as unknown as DataLayer;
}

const backend = import.meta.env.VITE_DATA_BACKEND ?? "mock";

export const db: DataLayer =
  backend === "supabase"
    ? lazySupabase()
    : backend === "starkeep"
      ? createStarkeepDataLayer(browserTransport)
      : createMockDataLayer();
