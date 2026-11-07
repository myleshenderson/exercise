/**
 * Pure TypeScript ports of the analysis SQL RPCs, for backends without SQL
 * functions. Each takes already-fetched row arrays for a single user (see
 * `rows.ts`) plus the RPC's arguments and returns the rows the RPC would.
 */
export { progressionForExercise } from "./progressionForExercise.js";
export { weeklyVolume } from "./weeklyVolume.js";
export { trainingGaps } from "./trainingGaps.js";
export { setsForExercise } from "./setsForExercise.js";
export { getWorkoutHistory } from "./getWorkoutHistory.js";
export { getDayTemplates } from "./getDayTemplates.js";
export { schemeHistoryForDayExercise } from "./schemeHistoryForDayExercise.js";
export { adherenceForDay } from "./adherenceForDay.js";
export type * from "./rows.js";
