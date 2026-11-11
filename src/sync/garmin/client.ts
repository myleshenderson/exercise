/**
 * Garmin Personal API client (AI-638). Pure: fetch, sleep and the clock are injected.
 * Auth is the flow of scripts/probes/garmin-probe.sh: POST the API key for a bare JWT
 * (24 h), then send it as a bearer token on every data call.
 */
import { fetchWithRetry, politePause, type FetchLike } from "../http.js";
import type { GarminDetail, GarminListItem, GarminWeightRange } from "./types.js";

export const GARMIN_BASE_URL = "https://personal.connectapi.garmin.com";
export const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
/** The token is replaced this long before its `exp`. */
export const TOKEN_REFRESH_MARGIN_MS = 300_000;
/** The spec's default page size for the activity search. */
export const ACTIVITY_PAGE_SIZE = 99;

/** The key or the token was refused. The run turns this into auth_status = "reconnect_required". */
export class GarminAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GarminAuthError";
  }
}

/** A data call answered with a non-2xx status (after retries). */
export class GarminHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`Garmin ${path} returned HTTP ${status}`);
    this.name = "GarminHttpError";
  }
}

export interface GarminClientDeps {
  fetch: FetchLike;
  apiKey: string;
  baseUrl?: string;
  sleep: (ms: number) => Promise<void>;
  /** Epoch ms, for the token cache (default Date.now). */
  now?: () => number;
}

export interface SearchActivitiesParams {
  /** 0-based offset. */
  start: number;
  /** Default 99. */
  limit?: number;
  /** `YYYY-MM-DD`, local start date. */
  startDate?: string;
  endDate?: string;
}

export interface GarminClient {
  token(): Promise<string>;
  searchActivities(p: SearchActivitiesParams): Promise<GarminListItem[]>;
  activityDetail(id: number | string): Promise<GarminDetail>;
  activityFitZip(id: number | string): Promise<Uint8Array>;
  weightRange(startDate: string, endDate: string): Promise<GarminWeightRange>;
}

/** `exp` (epoch seconds) from a JWT's payload; null when the token is not a JWT or has none. */
export function jwtExp(jwt: string): number | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
    const claims = JSON.parse(atob(b64)) as { exp?: unknown };
    return typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp : null;
  } catch {
    return null;
  }
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Nothing to release.
  }
}

export function createGarminClient(deps: GarminClientDeps): GarminClient {
  const baseUrl = (deps.baseUrl ?? GARMIN_BASE_URL).replace(/\/+$/, "");
  const now = deps.now ?? (() => Date.now());
  let cached: { jwt: string; refreshAtMs: number } | null = null;

  async function token(): Promise<string> {
    if (cached && now() < cached.refreshAtMs) return cached.jwt;
    cached = null;
    // One attempt, no retry: a 500 here means the key is not recognised (AI-627 probe findings).
    const res = await deps.fetch(baseUrl + TOKEN_PATH, {
      method: "POST",
      headers: { Authorization: `ApiKey ${deps.apiKey}`, Accept: "*/*" },
    });
    if (res.status !== 200) {
      await discard(res);
      throw new GarminAuthError(`GARMIN_API_KEY rejected (HTTP ${res.status})`);
    }
    const jwt = (await res.text()).replace(/["\s]/g, "");
    const exp = jwtExp(jwt);
    if (exp === null) throw new GarminAuthError("Garmin token response is not a JWT with an exp claim");
    cached = { jwt, refreshAtMs: exp * 1000 - TOKEN_REFRESH_MARGIN_MS };
    return jwt;
  }

  /** A bearer GET with retry, one token refresh on 401, and a polite pause after it. */
  async function get(path: string, accept = "application/json"): Promise<Response> {
    const send = async () =>
      fetchWithRetry(
        deps.fetch,
        baseUrl + path,
        { method: "GET", headers: { Authorization: `Bearer ${await token()}`, Accept: accept } },
        { sleep: deps.sleep },
      );
    let res = await send();
    if (res.status === 401) {
      await discard(res);
      cached = null;
      res = await send();
    }
    await politePause(deps.sleep, 1000);
    if (res.status === 401) {
      await discard(res);
      throw new GarminAuthError(`Garmin refused a fresh token on ${path} (HTTP 401)`);
    }
    if (!res.ok) {
      await discard(res);
      throw new GarminHttpError(res.status, path);
    }
    return res;
  }

  return {
    token,

    async searchActivities({ start, limit = ACTIVITY_PAGE_SIZE, startDate, endDate }) {
      const q = new URLSearchParams({ activityType: "cycling", limit: String(limit), start: String(start) });
      if (startDate) q.set("startDate", startDate);
      if (endDate) q.set("endDate", endDate);
      const path = `/activitylist-service/activities/search/activities?${q.toString()}`;
      const body: unknown = await (await get(path)).json();
      if (!Array.isArray(body)) throw new Error(`Garmin activity search did not return an array`);
      return body as GarminListItem[];
    },

    async activityDetail(id) {
      return (await (await get(`/activity-service/activity/${encodeURIComponent(String(id))}`)).json()) as GarminDetail;
    },

    async activityFitZip(id) {
      const res = await get(
        `/download-service/files/activity/${encodeURIComponent(String(id))}`,
        "application/zip, application/octet-stream",
      );
      return new Uint8Array(await res.arrayBuffer());
    },

    async weightRange(startDate, endDate) {
      const path = `/weight-service/weight/range/${startDate}/${endDate}?includeAll=true`;
      return (await (await get(path)).json()) as GarminWeightRange;
    },
  };
}
