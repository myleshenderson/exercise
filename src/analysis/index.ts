/**
 * Pure TypeScript ports of the analysis SQL RPCs, for backends without SQL
 * functions. Each takes already-fetched row arrays for a single user (see
 * `rows.ts`) plus the RPC's arguments and returns the rows the RPC would.
 */
export { progressionForExercise } from "./progressionForExercise";
export { weeklyVolume } from "./weeklyVolume";
export { trainingGaps } from "./trainingGaps";
export { setsForExercise } from "./setsForExercise";
export { getWorkoutHistory } from "./getWorkoutHistory";
export { getDayTemplates } from "./getDayTemplates";
export { schemeHistoryForDayExercise } from "./schemeHistoryForDayExercise";
export { adherenceForDay } from "./adherenceForDay";
export type * from "./rows";
