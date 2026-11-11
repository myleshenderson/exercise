/** Garmin Personal API adapter (AI-638): client, normalisers and the two sync runs. */
export {
  ACTIVITY_PAGE_SIZE,
  GARMIN_BASE_URL,
  GarminAuthError,
  GarminHttpError,
  createGarminClient,
  jwtExp,
  type GarminClient,
  type GarminClientDeps,
  type SearchActivitiesParams,
} from "./client.js";
export { garminToProvider, garminWeighIns } from "./normalize.js";
export { runGarminActivities, type GarminRunOptions } from "./runActivities.js";
export { EMPTY_YEARS_TO_STOP, OLDEST_YEAR, runGarminWeight } from "./runWeight.js";
export type * from "./types.js";
