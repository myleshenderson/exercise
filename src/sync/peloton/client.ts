/** Peloton API client (endpoints and headers from scripts/probes/peloton-probe.sh and AI-627 payload facts). */
import { fetchWithRetry, politePause, type FetchLike } from "../http.js";
import { PelotonHttpError } from "./errors.js";
import type { PelotonMe, PelotonPerformanceGraph, PelotonRideDetails, PelotonWorkoutDetail, PelotonWorkoutsPage } from "./types.js";

export const PELOTON_API_BASE = "https://api.onepeloton.com";
export const PELOTON_PAGE_LIMIT = 20;

export interface PelotonClient {
  me(): Promise<PelotonMe>;
  /** Newest first, 20 per page. */
  workouts(userId: string, page: number): Promise<PelotonWorkoutsPage>;
  workout(id: string): Promise<PelotonWorkoutDetail>;
  performanceGraph(id: string): Promise<PelotonPerformanceGraph>;
  rideDetails(rideId: string): Promise<PelotonRideDetails>;
  workoutHistoryCsv(userId: string): Promise<string>;
}

export interface PelotonClientDeps {
  fetch: FetchLike;
  /** Called once, on the first request; the token is kept in memory for the client's life. */
  getToken: () => Promise<string>;
  sleep: (ms: number) => Promise<void>;
}

const enc = encodeURIComponent;

/** Requests run one at a time, with a 1000 ms polite pause between them. */
export function createPelotonClient(deps: PelotonClientDeps): PelotonClient {
  let token: Promise<string> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let first = true;

  async function send(path: string): Promise<Response> {
    token ??= deps.getToken();
    const bearer = await token;
    if (!first) await politePause(deps.sleep, 1000);
    first = false;
    const res = await fetchWithRetry(
      deps.fetch,
      `${PELOTON_API_BASE}${path}`,
      { headers: { Authorization: `Bearer ${bearer}`, "peloton-platform": "web", Accept: "application/json" } },
      { sleep: deps.sleep },
    );
    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {
        // discarded either way
      }
      throw new PelotonHttpError(res.status, path);
    }
    return res;
  }

  function request<T>(path: string, read: (res: Response) => Promise<T>): Promise<T> {
    const run = queue.then(async () => read(await send(path)));
    queue = run.catch(() => undefined);
    return run;
  }

  const json = <T>(path: string) => request(path, (res) => res.json() as Promise<T>);

  return {
    me: () => json<PelotonMe>("/api/me"),
    workouts: (userId, page) =>
      json<PelotonWorkoutsPage>(
        `/api/user/${enc(userId)}/workouts?joins=ride,ride.instructor&limit=${PELOTON_PAGE_LIMIT}&page=${page}&sort_by=-created`,
      ),
    workout: (id) => json<PelotonWorkoutDetail>(`/api/workout/${enc(id)}?joins=ride,ride.instructor,user`),
    performanceGraph: (id) => json<PelotonPerformanceGraph>(`/api/workout/${enc(id)}/performance_graph?every_n=1`),
    rideDetails: (rideId) => json<PelotonRideDetails>(`/api/ride/${enc(rideId)}/details`),
    workoutHistoryCsv: (userId) =>
      request(`/api/user/${enc(userId)}/workout_history_csv?timezone=UTC`, (res) => res.text()),
  };
}
