/**
 * The Settings screen's client for `POST api/sync` (AI-652; the endpoint is AI-653's
 * `api/sync.ts`). Three implementations, picked by backend:
 *
 * - Supabase: `createFetchSyncClient`, bearer = the Supabase session's access token.
 * - mock (`VITE_DATA_BACKEND` unset or "mock"): `createMockSyncClient`, counts from the fixtures
 *   after 300 ms, for screenshots and tests.
 * - Starkeep: no client (`null`); sync runs on the Vercel deployment only.
 */
import { appPath, isStarkeepBackend } from "../../auth/backend";
import { loadSupabase } from "../../auth/supabase";
import type { DataLayer } from "../../data/DataLayer";
import type { SyncRunResult } from "../../sync/types";

export type { SyncRunResult };

export interface RecomputeResult {
  /** Sum of `activities` over every pass. */
  activities: number;
  /** `days` of the final pass. */
  days: number;
}

export interface SyncClient {
  /** One incremental sync of every source; rejects with `SyncClientError` on a non-200. */
  sync(): Promise<SyncRunResult[]>;
  /** Recomputes every activity's TSS and the daily load, repeating passes until `done`. */
  recompute(): Promise<RecomputeResult>;
}

/** A failed call: `message` is the endpoint's `error` text verbatim; a 500 may carry `results`. */
export class SyncClientError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly results: SyncRunResult[] | null = null,
  ) {
    super(message);
    this.name = "SyncClientError";
  }
}

type SyncBody = { kind: "sync"; results: SyncRunResult[] };
type RecomputeBody = { kind: "recompute"; activities: number; days: number; done: boolean; nextOffset: number | null };

export interface FetchSyncClientOptions {
  fetch?: typeof fetch;
  /** The bearer; `null` when signed out. Defaults to the Supabase session's access token. */
  getAccessToken?: () => Promise<string | null>;
  /** Guard against an endpoint that never answers `done`. */
  maxPasses?: number;
}

export const SIGNED_OUT = "Your session has expired — please sign in again.";

async function supabaseAccessToken(): Promise<string | null> {
  // `loadSupabase` loads supabase-js on demand (as src/screens/MCPLogin.tsx does).
  const { data } = await (await loadSupabase()).auth.getSession();
  return data?.session?.access_token ?? null;
}

export function createFetchSyncClient(options: FetchSyncClientOptions = {}): SyncClient {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const getAccessToken = options.getAccessToken ?? supabaseAccessToken;
  const maxPasses = options.maxPasses ?? 1000;

  async function post(query: string): Promise<unknown> {
    const token = await getAccessToken();
    if (!token) throw new SyncClientError(SIGNED_OUT, 401);
    let res: Response;
    try {
      res = await doFetch(`${appPath("api/sync")}${query}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      throw new SyncClientError(e instanceof Error ? e.message : String(e), null);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const b = (body ?? {}) as { error?: unknown; results?: unknown };
      const message = typeof b.error === "string" ? b.error : `Sync failed (HTTP ${res.status})`;
      throw new SyncClientError(message, res.status, Array.isArray(b.results) ? (b.results as SyncRunResult[]) : null);
    }
    return body;
  }

  return {
    async sync() {
      const body = (await post("")) as Partial<SyncBody> | null;
      if (!body || body.kind !== "sync" || !Array.isArray(body.results)) {
        throw new SyncClientError("Unexpected answer from api/sync", 200);
      }
      return body.results;
    },
    async recompute() {
      let activities = 0;
      let offset: number | null = null;
      for (let pass = 0; pass < maxPasses; pass++) {
        const query: string = offset === null ? "?recompute=all" : `?recompute=all&offset=${offset}`;
        const body = (await post(query)) as Partial<RecomputeBody> | null;
        if (!body || body.kind !== "recompute" || typeof body.activities !== "number" || typeof body.days !== "number") {
          throw new SyncClientError("Unexpected answer from api/sync", 200);
        }
        activities += body.activities;
        if (body.done) return { activities, days: body.days };
        if (typeof body.nextOffset !== "number") throw new SyncClientError("Recompute stopped without a next offset", 200);
        offset = body.nextOffset;
      }
      throw new SyncClientError(`Recompute did not finish in ${maxPasses} passes`, null);
    },
  };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The mock backend's client: after `delayMs`, a sync answers each stored `SyncState` row's counts
 * (and its `lastError`), and a recompute answers the stored activity and daily-load counts in one
 * pass (`done: true`).
 */
export function createMockSyncClient(db: DataLayer, delayMs = 300): SyncClient {
  return {
    async sync() {
      await wait(delayMs);
      const rows = await db.listSyncState();
      return rows.map((r) => ({
        source: r.source,
        fetched: r.itemsFetched,
        upserted: r.itemsUpserted,
        skipped: 0,
        done: r.backfillComplete,
        earliestAffected: null,
        error: r.lastError,
      }));
    },
    async recompute() {
      await wait(delayMs);
      const [activities, days] = await Promise.all([
        db.listExternalActivities({}),
        db.listDailyTrainingLoad("0001-01-01", "9999-12-31"),
      ]);
      return { activities: activities.length, days: days.length };
    },
  };
}

/** The client this build uses: Starkeep → `null`, Supabase → fetch, otherwise the mock. */
export function defaultSyncClient(db: DataLayer): SyncClient | null {
  if (isStarkeepBackend()) return null;
  const backend = import.meta.env.VITE_DATA_BACKEND;
  if (backend === undefined || backend === "" || backend === "mock") return createMockSyncClient(db);
  return createFetchSyncClient();
}
