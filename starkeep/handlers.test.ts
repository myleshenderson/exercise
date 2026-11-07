// @vitest-environment node
// api/mcp.ts reaches src/data/supabaseClient.ts, which reads import.meta.env.
/// <reference types="vite/client" />
/**
 * All 25 MCP tools under Starkeep (AI-604), called in-process through the
 * Hono app's `POST /mcp` with a real sealed bearer token.
 *
 * Real: the Hono app, token auth, `createServerTransport` → `signedFetch`,
 * the Starkeep DataLayer and row client, `starkeep/handlers.ts`, the analysis
 * functions. Stubbed: the app credential, Cognito (cloud tests), and the data
 * server (global `fetch`): `mcp_tokens` goes to a {@link FakeDataPlane}, every
 * app table to `createFakeTransport` over the manifest's tables, one per user
 * token so the cloud tests see per-user scoping.
 *
 * Parity: the same scenario is also loaded into a fake Supabase and the
 * Supabase handler set in `api/mcp.ts` is run over HTTP. Each parity test
 * asserts the expected text and that both backends return it byte for byte.
 * For the RPC-backed read tools the fake RPC answers with what Postgres
 * returns for the scenario, written out by hand below (not computed by the
 * analysis functions under test).
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../starkeep.manifest.json" with { type: "json" };
import { createFakeTransport, type FakeTable, type FakeTransport } from "../src/data/starkeep/fakeTransport.js";
import { FakeDataPlane, fakeJwt, mcpHeaders, TEST_CREDS } from "./test-support.js";
import type { Transport } from "./serverTransport.js";

// ---- module stubs -------------------------------------------------------------

const cognito = vi.hoisted(() => ({
  refreshTokens: vi.fn<(cfg: unknown, rt: string) => Promise<{ idToken: string; accessToken: string; expiresIn: number }>>(),
}));
const created = vi.hoisted(() => ({ transports: [] as { userToken: string | undefined; transport: unknown }[] }));

vi.mock("@starkeep/app-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@starkeep/app-client")>();
  return { ...actual, loadAppCredentials: async () => TEST_CREDS };
});

vi.mock("@starkeep/app-client/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@starkeep/app-client/auth")>();
  return {
    ...actual,
    poolConfig: () => ({ region: "us-east-1", userPoolId: "pool", userPoolClientId: "client" }),
    refreshTokens: cognito.refreshTokens,
  };
});

// Record every transport built, to prove one per request and never shared.
vi.mock("./serverTransport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./serverTransport.js")>();
  return {
    ...actual,
    createServerTransport: (opts: { userToken?: string } = {}): Transport => {
      const transport = actual.createServerTransport(opts);
      created.transports.push({ userToken: opts.userToken, transport });
      return transport;
    },
  };
});

// The Supabase side: identity is not under test, the database is a fake.
vi.mock("../api/mcp-auth.js", () => ({
  resolveIdentity: async () => ({ ok: true, userId: "user-a", accessToken: "access-a" }),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sb.client }));
vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");

const { createApp } = await import("./server.js");
const { resetMcpAuthCaches } = await import("./mcp-auth.js");
const { asPgTimestamptz } = await import("./handlers.js");
const { default: supabaseHandler } = await import("../api/mcp.js");

// ---- scenario -----------------------------------------------------------------

const P1 = "a0000000-0000-4000-8000-000000000001";
const D1 = "d0000000-0000-4000-8000-000000000001";
const D2 = "d0000000-0000-4000-8000-000000000002";
const D3 = "d0000000-0000-4000-8000-000000000003";
const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const E3 = "e0000000-0000-4000-8000-000000000003";
const E4 = "e0000000-0000-4000-8000-000000000004";
const E5 = "e0000000-0000-4000-8000-000000000005";
const E6 = "e0000000-0000-4000-8000-000000000006";
const S1 = "50000000-0000-4000-8000-000000000001";
const S2 = "50000000-0000-4000-8000-000000000002";
const S3 = "50000000-0000-4000-8000-000000000003";
const S4 = "50000000-0000-4000-8000-000000000004";
const S5 = "50000000-0000-4000-8000-000000000005";
const MISSING = "f0000000-0000-4000-8000-00000000ffff";
/** Ids handed out, in order, to rows created during a test (both backends). */
const NEW_IDS = [
  "c0000000-0000-4000-8000-000000000001",
  "c0000000-0000-4000-8000-000000000002",
  "c0000000-0000-4000-8000-000000000003",
  "c0000000-0000-4000-8000-000000000004",
];

const TS = (day: string) => `2026-${day}T00:00:00.000Z`;
const SCHEME = [
  { weight: 100, reps: 5 },
  { weight: 100, reps: 5 },
];

/**
 * One user's data, in Supabase column names (`deleted_at`, `target_sets` as
 * parsed jsonb). Loaded into the Starkeep fake with `archived_at` and
 * `target_sets` as JSON text.
 *
 * Program P1 holds D1 (done: S1 has sets) and D2 (not done), so D2 is next.
 * D3 is soft-deleted but S2 on it remains. E4 is soft-deleted. E5 is unused,
 * E6 has only scheme history.
 */
const SCENARIO = {
  programs: [{ id: P1, name: "Upper/Lower", created_at: TS("08-01"), deleted_at: null }],
  workout_days: [
    { id: D1, name: "Push", position: 0, program_id: P1, program_position: 0, created_at: TS("08-01"), deleted_at: null },
    { id: D2, name: "Pull", position: 1, program_id: P1, program_position: 1, created_at: TS("08-02"), deleted_at: null },
    { id: D3, name: "Old Legs", position: 2, program_id: null, program_position: null, created_at: TS("08-03"), deleted_at: TS("08-30") },
  ],
  exercises: [
    { id: E1, name: "bench press", cue: "Retract shoulder blades", default_sets: 3, default_rep_low: 5, default_rep_high: 8 },
    { id: E2, name: "Arnold Press", cue: "", default_sets: 3, default_rep_low: 10, default_rep_high: 12 },
    { id: E3, name: "Squat", cue: "Brace", default_sets: 5, default_rep_low: 3, default_rep_high: 5 },
    { id: E4, name: "Deadlift", cue: "", default_sets: 3, default_rep_low: 5, default_rep_high: 5, deleted_at: TS("08-20") },
    { id: E5, name: "Lateral Raise", cue: "", default_sets: 3, default_rep_low: 12, default_rep_high: 15 },
    { id: E6, name: "Good Morning", cue: "", default_sets: 3, default_rep_low: 8, default_rep_high: 10 },
  ].map((e, i) => ({ created_at: TS(`07-0${i + 1}`), deleted_at: null as string | null, ...e })),
  workout_day_exercises: [
    { id: "1e000000-0000-4000-8000-000000000001", workout_day_id: D1, exercise_id: E1, position: 0, target_sets: SCHEME },
    { id: "1e000000-0000-4000-8000-000000000002", workout_day_id: D1, exercise_id: E2, position: 1, target_sets: null },
    { id: "1e000000-0000-4000-8000-000000000003", workout_day_id: D2, exercise_id: E3, position: 0, target_sets: null },
  ],
  workout_day_exercise_scheme_history: [
    { id: "4e000000-0000-4000-8000-000000000001", workout_day_id: D1, exercise_id: E1, target_sets: SCHEME, recorded_at: TS("08-01") },
    { id: "4e000000-0000-4000-8000-000000000002", workout_day_id: D2, exercise_id: E6, target_sets: null, recorded_at: TS("08-02") },
  ],
  sessions: [
    { id: S1, workout_day_id: D1, performed_on: "2026-08-24", created_at: TS("08-24") },
    { id: S2, workout_day_id: D3, performed_on: "2026-08-26", created_at: TS("08-26") },
    { id: S3, workout_day_id: null, performed_on: "2026-08-27", created_at: TS("08-27") },
    { id: S4, workout_day_id: null, performed_on: "2026-09-02", created_at: TS("09-02") },
    { id: S5, workout_day_id: D1, performed_on: "2026-08-25", created_at: TS("08-25") },
  ],
  session_sets: [
    { id: "5e000000-0000-4000-8000-000000000001", session_id: S1, exercise_id: E1, set_number: 1, weight: 100, reps: 5 },
    { id: "5e000000-0000-4000-8000-000000000002", session_id: S1, exercise_id: E1, set_number: 2, weight: 100, reps: 5 },
    { id: "5e000000-0000-4000-8000-000000000003", session_id: S5, exercise_id: E2, set_number: 1, weight: 40, reps: 10 },
    { id: "5e000000-0000-4000-8000-000000000004", session_id: S2, exercise_id: E3, set_number: 1, weight: 140, reps: 5 },
    { id: "5e000000-0000-4000-8000-000000000005", session_id: S4, exercise_id: E3, set_number: 1, weight: 150, reps: 3 },
  ],
};
type TableName = keyof typeof SCENARIO;
type AnyRow = Record<string, unknown>;

/** The scenario as Starkeep rows. */
function toStarkeep(table: TableName, row: AnyRow): AnyRow {
  const out: AnyRow = { ...row };
  if ("deleted_at" in out) {
    out.archived_at = out.deleted_at;
    delete out.deleted_at;
  }
  if ("target_sets" in out) out.target_sets = out.target_sets === null ? null : JSON.stringify(out.target_sets);
  void table;
  return out;
}

// What Postgres returns for SCENARIO, by hand. jsonb prints keys shortest
// first ("reps" before "weight"); timestamptz prints as "+00:00".
const PG_SCHEME = [
  { reps: 5, weight: 100 },
  { reps: 5, weight: 100 },
];
const RPC_RESULTS: Record<string, unknown> = {
  progression_for_exercise: [
    { performed_on: "2026-08-24", sets: 2, top_weight: 100, volume: 1000 },
    { performed_on: "2026-08-25", sets: 1, top_weight: 40, volume: 400 },
  ],
  sets_for_exercise: [
    { performed_on: "2026-08-26", set_number: 1, weight: 140, reps: 5 },
    { performed_on: "2026-09-02", set_number: 1, weight: 150, reps: 3 },
  ],
  weekly_volume: [
    { week: "2026-08-24", sessions: 4, total_volume: 2100 },
    { week: "2026-08-31", sessions: 1, total_volume: 450 },
  ],
  training_gaps: [
    { performed_on: "2026-08-24", days_since_prev: null },
    { performed_on: "2026-08-25", days_since_prev: 1 },
    { performed_on: "2026-08-26", days_since_prev: 1 },
    { performed_on: "2026-08-27", days_since_prev: 1 },
    { performed_on: "2026-09-02", days_since_prev: 6 },
  ],
  get_day_templates: [
    {
      workout_day_id: D1, workout_day_name: "Push", workout_day_position: 0,
      program_id: P1, program_name: "Upper/Lower", program_position: 0, is_available: false,
      exercise_id: E1, exercise_name: "bench press", exercise_cue: "Retract shoulder blades", exercise_position: 0,
      target_sets: PG_SCHEME, uses_default_scheme: false, default_sets: 3, default_rep_low: 5, default_rep_high: 8,
    },
    {
      workout_day_id: D1, workout_day_name: "Push", workout_day_position: 0,
      program_id: P1, program_name: "Upper/Lower", program_position: 0, is_available: false,
      exercise_id: E2, exercise_name: "Arnold Press", exercise_cue: "", exercise_position: 1,
      target_sets: null, uses_default_scheme: true, default_sets: 3, default_rep_low: 10, default_rep_high: 12,
    },
    {
      workout_day_id: D2, workout_day_name: "Pull", workout_day_position: 1,
      program_id: P1, program_name: "Upper/Lower", program_position: 1, is_available: true,
      exercise_id: E3, exercise_name: "Squat", exercise_cue: "Brace", exercise_position: 0,
      target_sets: null, uses_default_scheme: true, default_sets: 5, default_rep_low: 3, default_rep_high: 5,
    },
  ],
  // start_date 2026-08-24, end_date 2026-08-26: S2's day D3 is deleted and still named.
  get_workout_history: [
    { session_id: S1, performed_on: "2026-08-24", workout_day_id: D1, workout_day_name: "Push", exercise_id: E1, exercise_name: "bench press", set_number: 1, weight: 100, reps: 5 },
    { session_id: S1, performed_on: "2026-08-24", workout_day_id: D1, workout_day_name: "Push", exercise_id: E1, exercise_name: "bench press", set_number: 2, weight: 100, reps: 5 },
    { session_id: S5, performed_on: "2026-08-25", workout_day_id: D1, workout_day_name: "Push", exercise_id: E2, exercise_name: "Arnold Press", set_number: 1, weight: 40, reps: 10 },
    { session_id: S2, performed_on: "2026-08-26", workout_day_id: D3, workout_day_name: "Old Legs", exercise_id: E3, exercise_name: "Squat", set_number: 1, weight: 140, reps: 5 },
  ],
  scheme_history_for_day_exercise: [{ target_sets: PG_SCHEME, recorded_at: "2026-08-01T00:00:00+00:00" }],
  // for D1: S1/E1 against H1's scheme, S5/E2 against E2's defaults (no history, no scheme).
  adherence_for_day: [
    {
      session_id: S1, performed_on: "2026-08-24", workout_day_id: D1, workout_day_name: "Push",
      exercise_id: E1, exercise_name: "bench press",
      actual_sets: 2, target_sets: 2, sets_status: "match",
      actual_avg_reps: 5, target_rep_low: 5, target_rep_high: 5, reps_status: "match",
      actual_top_weight: 100, target_weight: 100, weight_status: "match",
    },
    {
      session_id: S5, performed_on: "2026-08-25", workout_day_id: D1, workout_day_name: "Push",
      exercise_id: E2, exercise_name: "Arnold Press",
      actual_sets: 1, target_sets: 3, sets_status: "under",
      actual_avg_reps: 10, target_rep_low: 10, target_rep_high: 12, reps_status: "match",
      actual_top_weight: 40, target_weight: null, weight_status: null,
    },
  ],
};

// ---- fake Supabase (for api/mcp.ts) -----------------------------------------

const enUs = new Intl.Collator("en-US");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Just enough PostgREST query builder for src/data/supabase.ts and api/mcp.ts. */
class SbQuery implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private filters: [string, unknown][] = [];
  private orderBy?: { col: string; asc: boolean };
  private limitN?: number;
  private mode: "list" | "single" | "maybeSingle" = "list";
  private castError?: string;
  constructor(
    private table: string,
    private op: "select" | "insert" | "update" | "delete",
    private payload?: AnyRow | AnyRow[],
  ) {}
  select() { return this; }
  eq(col: string, val: unknown) {
    // Every id column is a Postgres uuid: a malformed value fails the cast.
    if ((col === "id" || col.endsWith("_id")) && typeof val === "string" && !UUID.test(val)) {
      this.castError ??= `invalid input syntax for type uuid: "${val}"`;
    }
    this.filters.push([col, val]);
    return this;
  }
  is(col: string, val: unknown) { this.filters.push([col, val]); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderBy = { col, asc: opts?.ascending ?? true }; return this; }
  limit(n: number) { this.limitN = n; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybeSingle"; return this; }

  private matched(): AnyRow[] {
    let out = sb.tables[this.table]!.filter((r) =>
      this.filters.every(([c, v]) => (v === null ? r[c] == null : r[c] === v)),
    );
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      out = out.slice().sort((a, b) => {
        const x = a[col];
        const y = b[col];
        // Postgres: ASC nulls last, DESC nulls first; text in en_US.
        if (x == null || y == null) return x == null && y == null ? 0 : (x == null ? 1 : -1) * (asc ? 1 : -1);
        const c = typeof x === "number" ? x - (y as number) : enUs.compare(String(x), String(y));
        return asc ? c : -c;
      });
    }
    return this.limitN === undefined ? out : out.slice(0, this.limitN);
  }

  private finish(rows: AnyRow[]) {
    if (this.mode === "single") return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
    if (this.mode === "maybeSingle") return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }

  private run() {
    if (this.castError) return { data: null, error: { message: this.castError } };
    const table = sb.tables[this.table]!;
    if (this.op === "select") return this.finish(this.matched());
    if (this.op === "delete") {
      const doomed = new Set(this.matched());
      sb.tables[this.table] = table.filter((r) => !doomed.has(r));
      return { data: null, error: null };
    }
    if (this.op === "update") {
      const hit = this.matched();
      for (const r of hit) Object.assign(r, this.payload);
      return this.finish(hit);
    }
    const inputs = Array.isArray(this.payload) ? this.payload : [this.payload!];
    const inserted = inputs.map((input) => {
      // Column defaults from supabase/migrations: position 0, nullable columns null.
      const row: AnyRow = { id: sb.nextId(), position: 0, deleted_at: null, created_at: new Date().toISOString(), ...input };
      table.push(row);
      return row;
    });
    return this.finish(inserted);
  }

  then<A = { data: unknown; error: { message: string } | null }, B = never>(
    ok?: ((v: { data: unknown; error: { message: string } | null }) => A | PromiseLike<A>) | null,
    fail?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, fail);
  }
}

const sb = {
  tables: {} as Record<string, AnyRow[]>,
  ids: [] as string[],
  nextId(): string {
    const id = sb.ids.shift();
    if (!id) throw new Error("fake Supabase ran out of ids");
    return id;
  },
  client: {
    from: (table: string) => ({
      select: () => new SbQuery(table, "select"),
      insert: (payload: AnyRow | AnyRow[]) => new SbQuery(table, "insert", payload),
      update: (payload: AnyRow) => new SbQuery(table, "update", payload),
      delete: () => new SbQuery(table, "delete"),
    }),
    rpc: async (name: string) => ({ data: structuredClone(RPC_RESULTS[name]), error: null }),
  },
};

// ---- fake data server (for Starkeep) -----------------------------------------

const SCHEMA = manifest.infraRequirements.appSpecificSyncable.tables as FakeTable[];

let plane: FakeDataPlane;
/** App tables per `X-Starkeep-User-Token` (null: local mode). */
let stores: Map<string | null, FakeTransport>;
/** Every app-table request the data server received. */
let dataRequests: { method: string; path: string; userToken: string | null }[];
const realFetch = globalThis.fetch;

function store(userToken: string | null): FakeTransport {
  let s = stores.get(userToken);
  if (!s) {
    s = createFakeTransport(SCHEMA);
    stores.set(userToken, s);
  }
  return s;
}

function seedStarkeep(s: FakeTransport): void {
  for (const table of Object.keys(SCENARIO) as TableName[]) {
    s.tables[table] = (structuredClone(SCENARIO[table]) as AnyRow[]).map((r) => toStarkeep(table, r));
  }
}

function seedSupabase(): void {
  sb.tables = structuredClone(SCENARIO) as unknown as Record<string, AnyRow[]>;
  sb.ids = [...NEW_IDS];
}

async function dataServerFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== new URL(TEST_CREDS.dataServerUrl).origin) return realFetch(input, init);
  if (url.pathname === "/app-data/db/mcp_tokens") return plane.fetch(input, init);
  const userToken = new Headers(init?.headers).get("x-starkeep-user-token");
  const method = (init?.method ?? "GET").toUpperCase();
  dataRequests.push({ method, path: url.pathname + url.search, userToken });
  return store(userToken).transport(url.pathname + url.search, { method, body: init?.body });
}

// ---- callers --------------------------------------------------------------------

interface ToolReply {
  content: { type: string; text: string }[];
  isError?: boolean;
}

let app: ReturnType<typeof createApp>;
let localToken: string;
let rpcId = 0;

function toolCall(name: string, args?: Record<string, unknown>) {
  return JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, ...(args ? { arguments: args } : {}) } });
}

/** Every tool called through the Starkeep app in this file; the last test checks all 25. */
const called = new Set<string>();

async function callStarkeep(name: string, args?: Record<string, unknown>, token = localToken): Promise<ToolReply> {
  called.add(name);
  const res = await app.request("/mcp", { method: "POST", headers: mcpHeaders(token), body: toolCall(name, args) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: ToolReply; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result!;
}

let supabaseServer: Server;
let supabaseUrl: string;

function withJsonBody(req: IncomingMessage): Promise<IncomingMessage & { body?: unknown }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const out = req as IncomingMessage & { body?: unknown };
      if (raw) out.body = JSON.parse(raw);
      resolve(out);
    });
    req.on("error", reject);
  });
}

async function callSupabase(name: string, args?: Record<string, unknown>): Promise<ToolReply> {
  const res = await realFetch(supabaseUrl, { method: "POST", headers: mcpHeaders("supabase-token"), body: toolCall(name, args) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: ToolReply; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result!;
}

const text = (r: ToolReply) => r.content[0]!.text;
const json = (data: unknown) => JSON.stringify(data, null, 2);

/** Calls one tool on both backends over the same scenario; returns the Starkeep reply after asserting they match. */
async function parity(name: string, args?: Record<string, unknown>): Promise<ToolReply> {
  seedSupabase();
  const supabase = await callSupabase(name, args);
  const starkeep = await callStarkeep(name, args);
  expect(text(starkeep)).toBe(text(supabase));
  expect(!!starkeep.isError).toBe(!!supabase.isError);
  return starkeep;
}

/**
 * The Starkeep DataLayer's crypto.randomUUID hands out NEW_IDS in order, as
 * the fake Supabase does. Only calls from src/data/starkeep.ts: the SDK and
 * the HTTP stack draw uuids of their own.
 */
function fixIds(): void {
  const ids = [...NEW_IDS];
  const original = crypto.randomUUID.bind(crypto);
  vi.spyOn(crypto, "randomUUID").mockImplementation(() =>
    new Error().stack?.includes("src/data/starkeep.ts")
      ? (ids.shift() as `${string}-${string}-${string}-${string}-${string}`)
      : original(),
  );
}

// ---- lifecycle ----------------------------------------------------------------

beforeAll(async () => {
  supabaseServer = createServer((req, res) => {
    withJsonBody(req).then((r) => supabaseHandler(r, res)).catch((err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => supabaseServer.listen(0, "127.0.0.1", resolve));
  supabaseUrl = `http://127.0.0.1:${(supabaseServer.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => supabaseServer.close(() => resolve()));
});

beforeEach(() => {
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  resetMcpAuthCaches();
  cognito.refreshTokens.mockReset();
  created.transports.length = 0;
  plane = new FakeDataPlane();
  stores = new Map();
  dataRequests = [];
  localToken = plane.seed().token;
  seedStarkeep(store(null));
  seedSupabase();
  vi.stubGlobal("fetch", dataServerFetch);
  app = createApp();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.STARKEEP_APP_CLIENT_MODE;
});

const local = () => store(null).tables;

// ---- read tools -----------------------------------------------------------------

describe("read tools: same text as api/mcp.ts's RPCs", () => {
  it("progression_for_exercise matches names with ILIKE (case-insensitive, partial)", async () => {
    const r = await parity("progression_for_exercise", { exercise_name: "press" });
    expect(text(r)).toBe(json(RPC_RESULTS.progression_for_exercise));
  });

  it("sets_for_exercise", async () => {
    const r = await parity("sets_for_exercise", { exercise_name: "squat" });
    expect(text(r)).toBe(json(RPC_RESULTS.sets_for_exercise));
  });

  it("weekly_volume counts set-less sessions and sessions on deleted days", async () => {
    const r = await parity("weekly_volume");
    expect(text(r)).toBe(json(RPC_RESULTS.weekly_volume));
  });

  it("training_gaps", async () => {
    const r = await parity("training_gaps", {});
    expect(text(r)).toBe(json(RPC_RESULTS.training_gaps));
  });

  it("get_day_templates drops the deleted day and prints target_sets as jsonb does", async () => {
    const r = await parity("get_day_templates");
    expect(text(r)).toBe(json(RPC_RESULTS.get_day_templates));
    expect(text(r)).not.toContain("Old Legs");
  });

  it("get_workout_history keeps the deleted day's sessions and name", async () => {
    const r = await parity("get_workout_history", { start_date: "2026-08-24", end_date: "2026-08-26" });
    expect(text(r)).toBe(json(RPC_RESULTS.get_workout_history));
    expect(text(r)).toContain('"workout_day_name": "Old Legs"');
  });

  it("get_workout_history bounds the session read by the date range", async () => {
    await callStarkeep("get_workout_history", { start_date: "2026-08-24", end_date: "2026-08-26" });
    const sessionsRead = dataRequests.find((r) => r.path.startsWith("/app-data/db/sessions"))!;
    expect(new URL(sessionsRead.path, "http://x").searchParams.get("where")).toBe(
      JSON.stringify({ performed_on: { gte: "2026-08-24", lte: "2026-08-26" } }),
    );
  });

  it("get_workout_history with no arguments object at all (defaulted to {}, as api/mcp.ts does)", async () => {
    const r = await callStarkeep("get_workout_history");
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(text(r))).toHaveLength(6);
  });

  it("get_workout_history filters by a literal exercise name substring", async () => {
    const r = await callStarkeep("get_workout_history", { exercise_name: "PRESS" });
    expect((JSON.parse(text(r)) as { exercise_name: string }[]).map((x) => x.exercise_name)).toEqual([
      "bench press",
      "bench press",
      "Arnold Press",
    ]);
  });

  it("scheme_history_for_day_exercise prints recorded_at as timestamptz", async () => {
    const r = await parity("scheme_history_for_day_exercise", { workout_day_id: D1, exercise_id: E1 });
    expect(text(r)).toBe(json(RPC_RESULTS.scheme_history_for_day_exercise));
  });

  it("scheme_history_for_day_exercise with a malformed id fails with Postgres's uuid error", async () => {
    const r = await callStarkeep("scheme_history_for_day_exercise", { workout_day_id: "Push", exercise_id: E1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('scheme_history_for_day_exercise failed: invalid input syntax for type uuid: "Push"');
  });

  it("adherence_for_day", async () => {
    const r = await parity("adherence_for_day", { workout_day_id: D1 });
    expect(text(r)).toBe(json(RPC_RESULTS.adherence_for_day));
  });

  it("a data-plane failure is a tool error, not a JSON-RPC error", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === "/app-data/db/sessions") return Response.json({ error: "boom" }, { status: 500 });
      return dataServerFetch(input, init);
    });
    const r = await callStarkeep("training_gaps");
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("training_gaps failed: Starkeep row API 500 on sessions: boom");
  });

  it("asPgTimestamptz formats like PostgREST", () => {
    expect(asPgTimestamptz("2026-08-01T00:00:00.000Z")).toBe("2026-08-01T00:00:00+00:00");
    expect(asPgTimestamptz("2026-08-01T00:00:00.120Z")).toBe("2026-08-01T00:00:00.12+00:00");
    expect(asPgTimestamptz("2026-08-01")).toBe("2026-08-01");
  });
});

// ---- exercises ----------------------------------------------------------------

describe("exercise tools", () => {
  it("list_exercises: live exercises in en_US name order, same as Supabase", async () => {
    const r = await parity("list_exercises");
    expect((JSON.parse(text(r)) as { name: string }[]).map((e) => e.name)).toEqual([
      "Arnold Press",
      "bench press",
      "Good Morning",
      "Lateral Raise",
      "Squat",
    ]);
  });

  it("create_exercise: same text as Supabase, and the row is written", async () => {
    fixIds();
    const r = await parity("create_exercise", { name: "Face Pull", cue: "High elbows", default_sets: 4 });
    expect(text(r)).toBe(
      json({ id: NEW_IDS[0], name: "Face Pull", cue: "High elbows", defaultSets: 4, defaultRepLow: 10, defaultRepHigh: 12 }),
    );
    expect(local().exercises!.find((e) => e.id === NEW_IDS[0])).toMatchObject({ name: "Face Pull", archived_at: null });
  });

  it("create_exercise validation", async () => {
    const r = await parity("create_exercise", { name: "X", default_rep_low: 0 });
    expect(text(r)).toBe("create_exercise failed: default_rep_low must be an integer between 1 and 40.");
  });

  it("update_exercise", async () => {
    const r = await parity("update_exercise", { id: E2, cue: "Rotate", default_rep_high: 15 });
    expect(text(r)).toBe(
      json({ id: E2, name: "Arnold Press", cue: "Rotate", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 15 }),
    );
  });

  it("update_exercise errors", async () => {
    expect(text(await parity("update_exercise", { id: E2 }))).toBe(
      "update_exercise failed: must provide at least one field to update.",
    );
    expect(text(await parity("update_exercise", { id: MISSING, name: "x" }))).toBe(
      `update_exercise failed: Exercise ${MISSING} not found.`,
    );
    expect(text(await parity("update_exercise", { id: E2, default_rep_low: 13 }))).toBe(
      "update_exercise failed: default_rep_low (13) must be less than or equal to default_rep_high (12).",
    );
    expect(text(await parity("update_exercise", { id: "bench", name: "x" }))).toBe(
      'update_exercise failed: expected a UUID for id, got "bench".',
    );
  });

  it("delete_exercise refuses an exercise attached to a day, in Supabase's words", async () => {
    const r = await parity("delete_exercise", { exercise_id: E1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(
      `delete_exercise failed: Exercise ${E1} is attached to one or more days; use remove_exercise_from_day to detach it first.`,
    );
    expect(local().exercises!.find((e) => e.id === E1)!.archived_at).toBeNull();
  });

  it("delete_exercise refuses an exercise with scheme history", async () => {
    const r = await parity("delete_exercise", { exercise_id: E6 });
    expect(text(r)).toBe(`delete_exercise failed: Exercise ${E6} has logged sets or scheme history and cannot be deleted.`);
  });

  it("delete_exercise soft-deletes an unused exercise", async () => {
    const r = await parity("delete_exercise", { exercise_id: E5 });
    expect(text(r)).toBe(json({ id: E5, name: "Lateral Raise", deleted: true }));
    expect(local().exercises!.find((e) => e.id === E5)!.archived_at).toEqual(expect.any(String));
  });

  it("delete_exercise on an already deleted exercise is not found", async () => {
    const r = await parity("delete_exercise", { exercise_id: E4 });
    expect(text(r)).toBe(`delete_exercise failed: Exercise ${E4} not found.`);
  });
});

// ---- days --------------------------------------------------------------------------

describe("day template tools", () => {
  it("create_day_template, in a program", async () => {
    fixIds();
    const r = await parity("create_day_template", { name: "Legs", program_id: P1 });
    expect(text(r)).toBe(json({ id: NEW_IDS[0], name: "Legs", position: 0, exerciseIds: [], programId: P1 }));
    expect(local().workout_days!.find((d) => d.id === NEW_IDS[0])).toMatchObject({ program_id: P1, program_position: 2 });
  });

  it("create_day_template with a missing program", async () => {
    const r = await parity("create_day_template", { name: "Legs", program_id: MISSING });
    expect(text(r)).toBe(`create_day_template failed: Program ${MISSING} not found.`);
  });

  it("rename_day_template", async () => {
    const r = await parity("rename_day_template", { day_id: D2, name: "Back" });
    expect(text(r)).toBe(json({ id: D2, name: "Back", position: 1 }));
    expect(local().workout_days!.find((d) => d.id === D2)!.name).toBe("Back");
  });

  it("rename_day_template on a deleted day is not found", async () => {
    const r = await parity("rename_day_template", { day_id: D3, name: "x" });
    expect(text(r)).toBe(`rename_day_template failed: Day template ${D3} not found.`);
  });

  it("delete_day_template", async () => {
    const r = await parity("delete_day_template", { day_id: D2 });
    expect(text(r)).toBe(json({ id: D2, name: "Pull", deleted: true }));
    expect(local().workout_days!.find((d) => d.id === D2)!.archived_at).toEqual(expect.any(String));
  });

  it("add_exercise_to_day appends at the next position", async () => {
    fixIds();
    const r = await parity("add_exercise_to_day", { day_id: D2, exercise_id: E5 });
    expect(text(r)).toBe(json({ day_id: D2, exercise_id: E5 }));
    expect(local().workout_day_exercises!.find((l) => l.workout_day_id === D2 && l.exercise_id === E5)).toMatchObject({
      position: 1,
    });
  });

  it("add_exercise_to_day refuses a duplicate", async () => {
    const r = await parity("add_exercise_to_day", { day_id: D1, exercise_id: E1 });
    expect(text(r)).toBe(`add_exercise_to_day failed: Exercise ${E1} is already on day ${D1}.`);
  });

  it("add_exercise_to_day: missing day, deleted exercise, malformed id", async () => {
    expect(text(await parity("add_exercise_to_day", { day_id: MISSING, exercise_id: E1 }))).toBe(
      `add_exercise_to_day failed: Day template ${MISSING} not found.`,
    );
    expect(text(await parity("add_exercise_to_day", { day_id: D2, exercise_id: E4 }))).toBe(
      `add_exercise_to_day failed: Exercise ${E4} not found.`,
    );
    expect(text(await parity("add_exercise_to_day", { day_id: "Push", exercise_id: E1 }))).toBe(
      'add_exercise_to_day failed: expected a UUID for day_id, got "Push".',
    );
  });

  it("remove_exercise_from_day", async () => {
    const r = await parity("remove_exercise_from_day", { day_id: D1, exercise_id: E2 });
    expect(text(r)).toBe(json({ day_id: D1, exercise_id: E2, removed: true }));
    expect(local().workout_day_exercises!.some((l) => l.workout_day_id === D1 && l.exercise_id === E2)).toBe(false);
  });

  it("reorder_day_exercises keeps each exercise's scheme", async () => {
    fixIds();
    const r = await parity("reorder_day_exercises", { day_id: D1, exercise_ids: [E2, E1] });
    expect(text(r)).toBe(json({ day_id: D1, exercise_ids: [E2, E1] }));
    const links = local().workout_day_exercises!.filter((l) => l.workout_day_id === D1);
    expect(links.map((l) => [l.exercise_id, l.position, l.target_sets])).toEqual(
      expect.arrayContaining([
        [E2, 0, null],
        [E1, 1, JSON.stringify(SCHEME)],
      ]),
    );
    expect(links).toHaveLength(2);
  });

  it("reorder_day_exercises refuses a membership change", async () => {
    const r = await parity("reorder_day_exercises", { day_id: D1, exercise_ids: [E1, E5] });
    expect(text(r)).toBe(
      `reorder_day_exercises failed: exercise_ids missing [${E2}] and unexpected [${E5}]. Use add_exercise_to_day/remove_exercise_from_day to change membership instead.`,
    );
    expect(text(await parity("reorder_day_exercises", { day_id: D1, exercise_ids: [E1, E1] }))).toBe(
      "reorder_day_exercises failed: exercise_ids contains duplicate ids.",
    );
  });

  it("set_day_exercise_scheme writes the scheme and a history row", async () => {
    fixIds();
    const sets = [
      { weight: 60, reps: 8 },
      { weight: 62.5, reps: 6 },
    ];
    const r = await parity("set_day_exercise_scheme", { day_id: D2, exercise_id: E3, sets });
    expect(text(r)).toBe(
      json({
        day_id: D2,
        exercise_id: E3,
        sets: [
          { setNumber: 1, weight: 60, reps: 8 },
          { setNumber: 2, weight: 62.5, reps: 6 },
        ],
      }),
    );
    expect(local().workout_day_exercises!.find((l) => l.workout_day_id === D2)!.target_sets).toBe(JSON.stringify(sets));
    expect(local().workout_day_exercise_scheme_history!.find((h) => h.id === NEW_IDS[0])).toMatchObject({
      workout_day_id: D2,
      exercise_id: E3,
      target_sets: JSON.stringify(sets),
    });
  });

  it("set_day_exercise_scheme errors", async () => {
    expect(text(await parity("set_day_exercise_scheme", { day_id: D2, exercise_id: E1, sets: null }))).toBe(
      `set_day_exercise_scheme failed: Exercise ${E1} is not on day ${D2}.`,
    );
    expect(text(await parity("set_day_exercise_scheme", { day_id: D2, exercise_id: E3, sets: [{ weight: 600, reps: 5 }] }))).toBe(
      "set_day_exercise_scheme failed: set 1 weight must be between 0 and 500.",
    );
  });
});

// ---- programs ------------------------------------------------------------------

describe("program tools", () => {
  it("create_program", async () => {
    fixIds();
    const r = await parity("create_program", { name: "PPL" });
    expect(text(r)).toBe(json({ id: NEW_IDS[0], name: "PPL" }));
  });

  it("rename_program", async () => {
    const r = await parity("rename_program", { program_id: P1, name: "UL" });
    expect(text(r)).toBe(json({ id: P1, name: "UL" }));
    expect(text(await parity("rename_program", { program_id: "nope", name: "UL" }))).toBe(
      'rename_program failed: Program nope not found.',
    );
  });

  it("delete_program", async () => {
    const r = await parity("delete_program", { program_id: P1 });
    expect(text(r)).toBe(json({ id: P1, name: "Upper/Lower", deleted: true }));
    expect(local().programs![0]!.archived_at).toEqual(expect.any(String));
  });

  it("add_day_to_program refuses a day already in a program", async () => {
    const r = await parity("add_day_to_program", { day_id: D1, program_id: P1 });
    expect(text(r)).toBe(`add_day_to_program failed: Day ${D1} is already in program ${P1}; remove it first.`);
  });

  it("remove_day_from_program, then add_day_to_program appends it", async () => {
    const removed = await parity("remove_day_from_program", { day_id: D1 });
    expect(text(removed)).toBe(json({ day_id: D1, removed: true }));
    expect(local().workout_days!.find((d) => d.id === D1)).toMatchObject({ program_id: null, program_position: null });

    const added = await callStarkeep("add_day_to_program", { day_id: D1, program_id: P1 });
    expect(text(added)).toBe(json({ day_id: D1, program_id: P1 }));
    expect(local().workout_days!.find((d) => d.id === D1)).toMatchObject({ program_id: P1, program_position: 2 });
  });

  it("add_day_to_program / remove_day_from_program with a malformed day id fail with Postgres's uuid error", async () => {
    expect(text(await parity("add_day_to_program", { day_id: "Push", program_id: P1 }))).toBe(
      'add_day_to_program failed: invalid input syntax for type uuid: "Push"',
    );
    expect(text(await parity("remove_day_from_program", { day_id: "Push" }))).toBe(
      'remove_day_from_program failed: invalid input syntax for type uuid: "Push"',
    );
  });

  it("reorder_program_days", async () => {
    const r = await parity("reorder_program_days", { program_id: P1, day_ids: [D2, D1] });
    expect(text(r)).toBe(json({ program_id: P1, day_ids: [D2, D1] }));
    expect(local().workout_days!.filter((d) => d.program_id === P1).map((d) => [d.id, d.program_position])).toEqual([
      [D1, 1],
      [D2, 0],
    ]);
  });

  it("reorder_program_days refuses a membership change", async () => {
    const r = await parity("reorder_program_days", { program_id: P1, day_ids: [D1] });
    expect(text(r)).toBe(
      `reorder_program_days failed: day_ids missing [${D2}]. Use add_day_to_program/remove_day_from_program to change membership instead.`,
    );
  });
});

// ---- every tool -----------------------------------------------------------------

describe("auth context", () => {
  it("no context means every tool answers unauthenticated", async () => {
    const { handleMcpRequest } = await import("./mcp.js");
    const res = await handleMcpRequest(
      new Request("http://local/mcp", { method: "POST", headers: mcpHeaders(), body: toolCall("list_exercises") }),
      {},
    );
    const body = (await res.json()) as { result: ToolReply };
    expect(body.result).toEqual({ isError: true, content: [{ type: "text", text: "unauthenticated" }] });
    expect(dataRequests).toHaveLength(0);
  });

  it("local mode sends no user token", async () => {
    await callStarkeep("list_exercises");
    expect(dataRequests.length).toBeGreaterThan(0);
    for (const r of dataRequests) expect(r.userToken).toBeNull();
  });
});

// ---- cloud: per-user tokens -------------------------------------------------

describe("cloud mode", () => {
  /** Cognito: refresh-<user> mints an ID token for <user>, distinct per mint. */
  let mints = 0;
  const subOf = (idToken: string | undefined | null) =>
    idToken ? (JSON.parse(Buffer.from(idToken.split(".")[1]!, "base64url").toString()) as { sub: string }).sub : null;

  beforeEach(() => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    mints = 0;
    cognito.refreshTokens.mockImplementation(async (_cfg, rt) => {
      mints += 1;
      const sub = rt.replace(/^refresh-/, "");
      // A distinct suffix per mint, after the signature, keeps the JWT decodable.
      return { idToken: `${fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, sub })}${mints}`, accessToken: "x", expiresIn: 3600 };
    });
    plane.ownerOf = (t) => subOf(t);
  });

  async function userWith(sub: string, exerciseName: string) {
    const { token } = plane.seed({ owner: sub, rt: `refresh-${sub}`, sub });
    // The data plane scopes rows by user: give each user their own store,
    // keyed by whatever ID token Cognito mints for them on first use.
    const warm = await callStarkeep("training_gaps", {}, token);
    expect(warm.isError).toBeUndefined();
    const idToken = dataRequests.at(-1)!.userToken!;
    expect(subOf(idToken)).toBe(sub);
    const s = store(idToken);
    s.tables.exercises = [
      { id: crypto.randomUUID(), name: exerciseName, cue: "", default_sets: 3, default_rep_low: 8, default_rep_high: 10, created_at: TS("08-01"), archived_at: null },
    ];
    return { token, idToken, store: s };
  }

  it("every row request during a tool call carries the context's user token", async () => {
    const a = await userWith("user-a", "A Press");
    a.store.tables.workout_days = [
      { id: D1, name: "Push", position: 0, program_id: null, program_position: null, created_at: TS("08-01"), archived_at: null },
    ];
    const exerciseId = a.store.tables.exercises![0]!.id as string;
    dataRequests = [];
    const r = await callStarkeep("add_exercise_to_day", { day_id: D1, exercise_id: exerciseId }, a.token);
    expect(text(r)).toBe(json({ day_id: D1, exercise_id: exerciseId }));
    // findDay, findExercise, duplicate check, last position, insert.
    expect(dataRequests.length).toBeGreaterThanOrEqual(5);
    for (const req of dataRequests) expect(req.userToken).toBe(a.idToken);
    expect(a.store.tables.workout_day_exercises).toHaveLength(1);
  });

  it("two concurrent requests with different contexts never share a transport", async () => {
    const a = await userWith("user-a", "A Press");
    const b = await userWith("user-b", "B Row");
    created.transports.length = 0;
    dataRequests = [];

    const [ra, rb] = await Promise.all([
      callStarkeep("list_exercises", undefined, a.token),
      callStarkeep("list_exercises", undefined, b.token),
    ]);
    expect((JSON.parse(text(ra)) as { name: string }[]).map((e) => e.name)).toEqual(["A Press"]);
    expect((JSON.parse(text(rb)) as { name: string }[]).map((e) => e.name)).toEqual(["B Row"]);

    // One transport for the auth lookup and one for the tools, per request;
    // all distinct objects, each bound to its own request's user token.
    expect(created.transports).toHaveLength(4);
    expect(new Set(created.transports.map((t) => t.transport)).size).toBe(4);
    expect(created.transports.map((t) => t.userToken).sort()).toEqual([a.idToken, a.idToken, b.idToken, b.idToken].sort());

    const appReads = dataRequests.filter((r) => r.path.startsWith("/app-data/db/exercises"));
    expect(appReads).toHaveLength(2);
    expect(appReads.map((r) => r.userToken).sort()).toEqual([a.idToken, b.idToken].sort());
  });
});

// Runs last (vitest runs a file's tests in order): every tool was exercised.
describe("coverage", () => {
  it("every one of the 25 tools in tools/list was called through the Starkeep app above", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders(localToken),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const names = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(names).toHaveLength(25);
    expect(names.filter((n) => !called.has(n))).toEqual([]);
  });
});
