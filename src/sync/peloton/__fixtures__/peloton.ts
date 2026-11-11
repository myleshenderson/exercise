/**
 * Synthetic Peloton payloads for the adapter tests. Shapes follow AI-627 payload facts 7 to 11;
 * every id, FTP, name and count is made up.
 */
import type { FetchLike } from "../../http.js";
import type {
  PelotonPerformanceGraph,
  PelotonRideDetails,
  PelotonWorkout,
  PelotonWorkoutDetail,
  PelotonWorkoutsPage,
} from "../types.js";

export const USER_ID = "u0000000000000000000000000000001";
export const CLASS_ID = "w0000000000000000000000000000001";
export const STRETCH_ID = "w0000000000000000000000000000002";
export const FREESTYLE_ID = "w0000000000000000000000000000003";
export const OLD_TEST_ID = "w0000000000000000000000000000009";
export const CLASS_RIDE_ID = "r0000000000000000000000000000001";
export const STRETCH_RIDE_ID = "r0000000000000000000000000000002";
export const FREESTYLE_RIDE_ID = "r0000000000000000000000000000003";
export const SYNTHETIC_FTP = 123;

/** 2026-01-02T12:01:00Z = 07:01 in Etc/GMT+5 (UTC−5). */
export const CLASS_START = 1767355260;
/** 2026-01-02T12:30:00Z. */
export const STRETCH_START = 1767357000;
/** 2026-01-01T15:30:00Z = 10:30 in Etc/GMT+5. */
export const FREESTYLE_START = 1767281400;

export const classWorkout: PelotonWorkout = {
  id: CLASS_ID,
  user_id: USER_ID,
  name: "Cycling Workout",
  fitness_discipline: "cycling",
  workout_type: "class",
  is_outdoor: false,
  created_at: CLASS_START - 60,
  device_time_created_at: CLASS_START - 60 - 18000,
  start_time: CLASS_START,
  end_time: CLASS_START + 120,
  timezone: "Etc/GMT+5",
  total_work: 30000,
  distance: 0.5,
  calories: 25,
  status: "COMPLETE",
  ride: {
    id: CLASS_RIDE_ID,
    title: "2 min FTP Test Ride",
    duration: 120,
    pedaling_start_offset: 60,
    fitness_discipline: "cycling",
    instructor: { name: "Synthetic Instructor" },
  },
};

export const stretchWorkout: PelotonWorkout = {
  id: STRETCH_ID,
  user_id: USER_ID,
  name: "Stretching Workout",
  fitness_discipline: "stretching",
  workout_type: "class",
  is_outdoor: false,
  start_time: STRETCH_START,
  end_time: STRETCH_START + 300,
  timezone: "Etc/GMT+5",
  calories: 10,
  ride: { id: STRETCH_RIDE_ID, title: "5 min Synthetic Stretch", fitness_discipline: "stretching" },
};

export const freestyleWorkout: PelotonWorkout = {
  id: FREESTYLE_ID,
  user_id: USER_ID,
  name: "Cycling Workout",
  title: "10 min Just Ride",
  fitness_discipline: "cycling",
  workout_type: "freestyle",
  is_outdoor: false,
  start_time: FREESTYLE_START,
  end_time: FREESTYLE_START + 600,
  timezone: "Etc/GMT+5",
  total_work: 66000,
  distance: 3.1,
  calories: 70,
  ride: { id: FREESTYLE_RIDE_ID, title: null },
};

function page(n: number, data: PelotonWorkout[]): PelotonWorkoutsPage {
  return { data, limit: 20, page: n, total: 3, count: data.length, page_count: 2, show_next: n === 0, sort_by: "-created" };
}

/** Newest first: stretch, class on page 0; freestyle on page 1. */
export const listPage0 = page(0, [stretchWorkout, classWorkout]);
export const listPage1 = page(1, [freestyleWorkout]);

export const classDetail: PelotonWorkoutDetail = {
  ...classWorkout,
  ftp_info: { ftp: SYNTHETIC_FTP, ftp_source: "ftp_workout_source", ftp_workout_id: OLD_TEST_ID },
  user: { id: USER_ID },
};

export const freestyleDetail: PelotonWorkoutDetail = {
  ...freestyleWorkout,
  ftp_info: { ftp: SYNTHETIC_FTP, ftp_source: "ftp_manual_source", ftp_workout_id: null },
};

export const classRideDetails: PelotonRideDetails = { ride: { id: CLASS_RIDE_ID }, is_ftp_test: true, is_power_zone_class: false };

/** Seconds 1..120 with second 60 missing (a dropout): 119 samples per metric. */
export const GRAPH_SECONDS = Array.from({ length: 120 }, (_, i) => i + 1).filter((s) => s !== 60);

export const graph120: PelotonPerformanceGraph = {
  duration: 120,
  seconds_since_pedaling_start: GRAPH_SECONDS,
  metrics: [
    { slug: "output", display_name: "Output", display_unit: "watts", values: GRAPH_SECONDS.map((s) => 100 + (s % 10)), average_value: 104, max_value: 109 },
    { slug: "cadence", display_name: "Cadence", display_unit: "rpm", values: GRAPH_SECONDS.map(() => 80), average_value: 80, max_value: 80 },
    { slug: "resistance", display_name: "Resistance", display_unit: "%", values: GRAPH_SECONDS.map(() => 40), average_value: 40, max_value: 40 },
    { slug: "speed", display_name: "Speed", display_unit: "mph", values: GRAPH_SECONDS.map(() => 20), average_value: 20, max_value: 25 },
    {
      slug: "heart_rate",
      display_name: "Heart Rate",
      display_unit: "bpm",
      values: GRAPH_SECONDS.map((s) => (s === 30 ? null : 130)),
      average_value: 130,
      max_value: 140,
      zones: [],
      missing_data_duration: 1,
    },
  ],
  summaries: [
    { slug: "total_output", display_name: "Total Output", display_unit: "kj", value: 30 },
    { slug: "distance", display_name: "Distance", display_unit: "mi", value: 0.5 },
    { slug: "calories", display_name: "Calories", display_unit: "kcal", value: 25 },
  ],
  average_summaries: [
    { slug: "avg_output", display_name: "Avg Output", display_unit: "watts", value: 104 },
    { slug: "avg_cadence", display_name: "Avg Cadence", display_unit: "rpm", value: 80 },
    { slug: "avg_resistance", display_name: "Avg Resistance", display_unit: "%", value: 40 },
    { slug: "avg_speed", display_name: "Avg Speed", display_unit: "mph", value: 20 },
  ],
};

/**
 * Three rows: two share the class's minute and title (the duplicate-timestamp case; Total Output
 * 45 kJ listed first, 30 kJ = the class), one is the freestyle ride. Instructor names are quoted.
 */
export const workoutHistoryCsv = [
  "Workout Timestamp,Live/On-Demand,Instructor Name,Length (minutes),Fitness Discipline,Type,Title,Class Timestamp,Total Output,Avg. Watts,Avg. Resistance,Avg. Cadence (RPM),Avg. Speed (mph),Distance (mi),Calories Burned,Avg. Heartrate,Avg. Incline,Avg. Pace (min/mi)",
  '2026-01-02 07:01 (EST),On Demand,"Instructor, Synthetic",2,Cycling,Power Zone,2 min FTP Test Ride,2025-12-01 06:00 (EST),45,150,45%,85,21.00,0.70,40,140.5,,',
  '2026-01-02 07:01 (-05),On Demand,"Instructor, Synthetic",2,Cycling,Power Zone,2 min FTP Test Ride,2025-12-01 06:00 (EST),30,104,40%,80,20.00,0.50,25,130.0,,',
  '2026-01-01 10:30 (-05),,"",10,Cycling,,10 min Just Ride,,66,110,38%,78,18.00,3.10,70,,,',
].join("\r\n") + "\r\n";

export const auth0WithRefresh = { access_token: "access-token-1", refresh_token: "refresh-token-2", expires_in: 172800, token_type: "Bearer", scope: "openid offline_access" };
export const auth0WithoutRefresh = { access_token: "access-token-1", expires_in: 172800, token_type: "Bearer" };
export const auth0InvalidGrant = { error: "invalid_grant", error_description: "Unknown or invalid refresh token." };

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export interface RecordedCall {
  url: string;
  init?: RequestInit;
}

/**
 * A fetch that answers from `route(url, init)` and records every call. `route` returning
 * undefined is a test bug and yields a 599.
 */
export function fakeFetch(route: (url: string, init?: RequestInit) => Response | undefined) {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return route(url, init) ?? new Response(`no route for ${url}`, { status: 599 });
  };
  return { fetch, calls };
}

/** Routes the Peloton API (not Auth0) from the fixtures above; `override` wins for a path it answers. */
export function pelotonApi(override: (path: string) => Response | undefined = () => undefined) {
  return (url: string): Response | undefined => {
    const u = new URL(url);
    if (u.host !== "api.onepeloton.com") return undefined;
    const path = u.pathname;
    const hit = override(`${path}${u.search}`) ?? override(path);
    if (hit) return hit;
    if (path === "/api/me") return jsonResponse({ id: USER_ID, username: "synthetic" });
    if (path === `/api/user/${USER_ID}/workouts`) return jsonResponse(u.searchParams.get("page") === "1" ? listPage1 : listPage0);
    if (path === `/api/workout/${CLASS_ID}`) return jsonResponse(classDetail);
    if (path === `/api/workout/${FREESTYLE_ID}`) return jsonResponse(freestyleDetail);
    if (path === `/api/workout/${CLASS_ID}/performance_graph` || path === `/api/workout/${FREESTYLE_ID}/performance_graph`)
      return jsonResponse(graph120);
    if (path === `/api/ride/${CLASS_RIDE_ID}/details`) return jsonResponse(classRideDetails);
    if (path === `/api/user/${USER_ID}/workout_history_csv`) return new Response(workoutHistoryCsv, { status: 200, headers: { "Content-Type": "text/csv" } });
    return new Response("not found", { status: 404 });
  };
}
