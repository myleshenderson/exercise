// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sha256Hex } from "./mcp-login.js";

// Fake mcp_sessions store + GoTrue refresh + per-user RPC fixtures, keyed the same way
// the real Supabase tables are: a session row maps a hashed bearer token to a
// refresh_token, refreshing a refresh_token rotates it (old one dead, per Supabase's
// rotation behavior), and RPC results are scoped to whichever user the caller's
// current access_token belongs to.
type SessionRow = { id: string; user_id: string; refresh_token: string };

const sessionsById = new Map<string, SessionRow>();
const tokenHashToId = new Map<string, string>();
const validRefreshTokens = new Map<string, string>();
const accessTokenOwner = new Map<string, string>();
const rpcCalls: Array<{ name: string; args?: Record<string, unknown> }> = [];
let seq = 0;

interface FakeRow {
  id: string;
  user_id: string;
  [key: string]: unknown;
}

type FakeTableName = "workout_days" | "exercises" | "workout_day_exercises";

const TABLES: Record<FakeTableName, FakeRow[]> = {
  workout_days: [],
  exercises: [],
  workout_day_exercises: [],
};
let fakeRowSeq = 0;
function nextFakeId(prefix: string): string {
  return `${prefix}-${++fakeRowSeq}`;
}

type FakeResult = { data: unknown; error: { message: string } | null };
type FakeMode = "list" | "single" | "maybeSingle";

// Emulates just enough of Postgres RLS for the write tools under test: every row is
// owned by whichever user's access token built the client, select/update/delete only
// ever see rows owned by that caller (own_select/own_update/own_delete), and inserting
// into workout_day_exercises additionally requires the referenced day and exercise to
// both already belong to that same caller (0003_harden_child_rls.sql).
class FakeQuery implements PromiseLike<FakeResult> {
  private filters: Array<[string, unknown]> = [];
  private orderCol?: string;
  private orderAsc = true;
  private limitN?: number;
  private mode: FakeMode = "list";

  constructor(
    private tableName: FakeTableName,
    private table: FakeRow[],
    private callerId: string,
    private op: "select" | "insert" | "update" | "delete",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private payload?: any,
  ) {}

  select(): this {
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push([col, val]);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  single(): this {
    this.mode = "single";
    return this;
  }
  maybeSingle(): this {
    this.mode = "maybeSingle";
    return this;
  }

  private owned(): FakeRow[] {
    return this.table.filter((r) => r.user_id === this.callerId);
  }

  private matched(rows: FakeRow[]): FakeRow[] {
    let out = rows.filter((r) => this.filters.every(([col, val]) => r[col] === val));
    if (this.orderCol) {
      const col = this.orderCol;
      const dir = this.orderAsc ? 1 : -1;
      out = out.slice().sort((a, b) => ((a[col] as number) - (b[col] as number)) * dir);
    }
    if (this.limitN !== undefined) out = out.slice(0, this.limitN);
    return out;
  }

  private finish(rows: FakeRow[]): FakeResult {
    if (this.mode === "single") {
      return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: "no rows found" } };
    }
    if (this.mode === "maybeSingle") {
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  }

  private run(): FakeResult {
    if (this.op === "select") return this.finish(this.matched(this.owned()));

    if (this.op === "delete") {
      for (const row of this.matched(this.owned())) {
        const idx = this.table.indexOf(row);
        if (idx !== -1) this.table.splice(idx, 1);
      }
      return { data: null, error: null };
    }

    if (this.op === "update") {
      const targets = this.matched(this.owned());
      for (const row of targets) Object.assign(row, this.payload);
      return this.finish(targets);
    }

    const inputs: Array<Record<string, unknown>> = Array.isArray(this.payload) ? this.payload : [this.payload];
    const inserted: FakeRow[] = [];
    for (const input of inputs) {
      if (this.tableName === "workout_day_exercises") {
        const dayOwned = TABLES.workout_days.some((d) => d.id === input.workout_day_id && d.user_id === this.callerId);
        const exOwned = TABLES.exercises.some((e) => e.id === input.exercise_id && e.user_id === this.callerId);
        if (!dayOwned || !exOwned) {
          return { data: null, error: { message: "new row violates row-level security policy" } };
        }
      }
      // position defaults to 0, mirroring workout_days.position/workout_day_exercises.position's
      // `not null default 0` column default — overridable when the caller supplies it explicitly
      // (e.g. addExerciseToDay, updateDayExercises).
      const row: FakeRow = { id: nextFakeId(this.tableName), user_id: this.callerId, position: 0, ...input };
      this.table.push(row);
      inserted.push(row);
    }
    return this.finish(inserted);
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onfulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

function fakeFrom(tableName: FakeTableName, callerId: string | undefined) {
  const table = TABLES[tableName];
  if (!callerId) {
    const errResult: FakeResult = { data: null, error: { message: "invalid access token" } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stub: any = {
      select: () => stub,
      insert: () => stub,
      update: () => stub,
      delete: () => stub,
      eq: () => stub,
      order: () => stub,
      limit: () => stub,
      single: () => stub,
      maybeSingle: () => stub,
      then: (res: (v: FakeResult) => unknown) => Promise.resolve(errResult).then(res),
    };
    return stub;
  }
  return {
    select: () => new FakeQuery(tableName, table, callerId, "select"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insert: (payload: any) => new FakeQuery(tableName, table, callerId, "insert", payload),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: (payload: any) => new FakeQuery(tableName, table, callerId, "update", payload),
    delete: () => new FakeQuery(tableName, table, callerId, "delete"),
  };
}

function seedDay(userId: string, id: string, name: string, position = 0): FakeRow {
  const row: FakeRow = { id, user_id: userId, name, position };
  TABLES.workout_days.push(row);
  return row;
}

function seedExercise(userId: string, id: string, name: string): FakeRow {
  const row: FakeRow = { id, user_id: userId, name, cue: "", default_sets: 3, default_rep_low: 10, default_rep_high: 12 };
  TABLES.exercises.push(row);
  return row;
}

function seedDayExercise(userId: string, dayId: string, exerciseId: string, position: number, targetSets: unknown = null): FakeRow {
  const row: FakeRow = {
    id: nextFakeId("wde"),
    user_id: userId,
    workout_day_id: dayId,
    exercise_id: exerciseId,
    position,
    target_sets: targetSets,
  };
  TABLES.workout_day_exercises.push(row);
  return row;
}

const FIXTURES: Record<
  string,
  {
    progression_for_exercise: unknown;
    sets_for_exercise: unknown;
    weekly_volume: unknown;
    training_gaps: unknown;
    get_day_templates: unknown;
    get_workout_history: unknown;
    scheme_history_for_day_exercise: unknown;
    adherence_for_day: unknown;
  }
> = {
  "user-a": {
    progression_for_exercise: [{ performed_on: "2026-08-01", sets: 3, top_weight: 100, volume: 3000 }],
    sets_for_exercise: [{ performed_on: "2026-08-01", set_number: 1, weight: 95, reps: 5 }],
    weekly_volume: [{ week: "2026-08-24", sessions: 2, total_volume: 8000 }],
    training_gaps: [{ performed_on: "2026-08-24", days_since_prev: null }],
    get_day_templates: [{ workout_day_id: "day-a", workout_day_name: "Push", exercise_name: "Bench" }],
    get_workout_history: [{ session_id: "sess-a", performed_on: "2026-08-24", exercise_name: "Bench" }],
    scheme_history_for_day_exercise: [{ target_sets: [{ weight: 225, reps: 5 }], recorded_at: "2026-08-01T00:00:00Z" }],
    adherence_for_day: [
      { session_id: "sess-a", performed_on: "2026-08-24", exercise_name: "Bench", sets_status: "match", reps_status: "match", weight_status: "under" },
    ],
  },
  "user-b": {
    progression_for_exercise: [{ performed_on: "2026-08-02", sets: 5, top_weight: 200, volume: 6000 }],
    sets_for_exercise: [{ performed_on: "2026-08-02", set_number: 1, weight: 185, reps: 5 }],
    weekly_volume: [{ week: "2026-08-24", sessions: 1, total_volume: 4000 }],
    training_gaps: [{ performed_on: "2026-08-26", days_since_prev: null }],
    get_day_templates: [{ workout_day_id: "day-b", workout_day_name: "Pull", exercise_name: "Row" }],
    get_workout_history: [{ session_id: "sess-b", performed_on: "2026-08-26", exercise_name: "Row" }],
    scheme_history_for_day_exercise: [{ target_sets: [{ weight: 185, reps: 5 }], recorded_at: "2026-08-02T00:00:00Z" }],
    adherence_for_day: [
      { session_id: "sess-b", performed_on: "2026-08-26", exercise_name: "Row", sets_status: "over", reps_status: "match", weight_status: "match" },
    ],
  },
};

function seedSession(userId: string, bearerToken: string): void {
  const id = `row-${userId}`;
  const refreshToken = `refresh-${userId}-0`;
  sessionsById.set(id, { id, user_id: userId, refresh_token: refreshToken });
  tokenHashToId.set(sha256Hex(bearerToken), id);
  validRefreshTokens.set(refreshToken, userId);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSupabaseClient(_url: string, _key: string, options?: any) {
  const authHeader: string | undefined = options?.global?.headers?.Authorization;

  if (authHeader) {
    const accessToken = authHeader.replace(/^Bearer /, "");
    return {
      rpc: async (name: string, args?: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        const userId = accessTokenOwner.get(accessToken);
        if (!userId) return { data: null, error: { message: "invalid access token" } };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { data: (FIXTURES[userId] as any)[name], error: null };
      },
      from: (tableName: FakeTableName) => fakeFrom(tableName, accessTokenOwner.get(accessToken)),
    };
  }

  return {
    from: () => ({
      select: () => ({
        eq: (_col: string, hash: string) => ({
          maybeSingle: async () => {
            const id = tokenHashToId.get(hash);
            if (!id) return { data: null, error: null };
            const row = sessionsById.get(id)!;
            return { data: { id: row.id, user_id: row.user_id, refresh_token: row.refresh_token }, error: null };
          },
        }),
      }),
      update: (patch: { refresh_token: string }) => ({
        eq: async (_col: string, id: string) => {
          const row = sessionsById.get(id);
          if (row) row.refresh_token = patch.refresh_token;
          return { error: null };
        },
      }),
    }),
    auth: {
      refreshSession: async ({ refresh_token }: { refresh_token: string }) => {
        const userId = validRefreshTokens.get(refresh_token);
        if (!userId) return { data: { session: null }, error: { message: "invalid grant" } };
        validRefreshTokens.delete(refresh_token);
        seq += 1;
        const accessToken = `access-${userId}-${seq}`;
        const rotatedRefreshToken = `refresh-${userId}-${seq}`;
        validRefreshTokens.set(rotatedRefreshToken, userId);
        accessTokenOwner.set(accessToken, userId);
        return { data: { session: { access_token: accessToken, refresh_token: rotatedRefreshToken } }, error: null };
      },
    },
  };
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn((...args: unknown[]) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    makeSupabaseClient(...(args as [string, string, any?])),
  ),
}));

vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");

const { default: handler } = await import("./mcp");

function withJsonBody(req: import("node:http").IncomingMessage): Promise<import("node:http").IncomingMessage & { body?: unknown }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const reqWithBody = req as import("node:http").IncomingMessage & { body?: unknown };
      if (raw.length > 0) {
        try {
          reqWithBody.body = JSON.parse(raw);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
      }
      resolve(reqWithBody);
    });
    req.on("error", reject);
  });
}

describe("api/mcp handler", () => {
  let server: Server;
  let baseUrl: URL;

  beforeEach(async () => {
    sessionsById.clear();
    tokenHashToId.clear();
    validRefreshTokens.clear();
    accessTokenOwner.clear();
    rpcCalls.length = 0;
    seq = 0;
    TABLES.workout_days.length = 0;
    TABLES.exercises.length = 0;
    TABLES.workout_day_exercises.length = 0;
    fakeRowSeq = 0;
    seedSession("user-a", "token-a");
    seedSession("user-b", "token-b");

    server = createServer((req, res) => {
      withJsonBody(req)
        .then((reqWithBody) => handler(reqWithBody, res))
        .catch((err) => {
          res.statusCode = 500;
          res.end(String(err));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = new URL(`http://127.0.0.1:${port}/api/mcp`);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function connectAs(bearerToken: string): Promise<Client> {
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(baseUrl, {
      requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } },
    });
    await client.connect(transport);
    return client;
  }

  it("lists the progression, sets, weekly-volume, training-gaps, day-templates, and workout-history tools", async () => {
    const client = await connectAs("token-a");

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_exercise_to_day",
      "adherence_for_day",
      "create_day_template",
      "create_exercise",
      "delete_day_template",
      "get_day_templates",
      "get_workout_history",
      "progression_for_exercise",
      "remove_exercise_from_day",
      "rename_day_template",
      "reorder_day_exercises",
      "scheme_history_for_day_exercise",
      "sets_for_exercise",
      "training_gaps",
      "weekly_volume",
    ]);

    await client.close();
  });

  it("rejects GET with 405 instead of opening a long-lived stream a serverless invocation can't sustain", async () => {
    const response = await fetch(baseUrl, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
    });
    expect(response.status).toBe(405);
  });

  it("lists tools with no Authorization header at all, since listing doesn't need a user identity", async () => {
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(baseUrl);
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_exercise_to_day",
      "adherence_for_day",
      "create_day_template",
      "create_exercise",
      "delete_day_template",
      "get_day_templates",
      "get_workout_history",
      "progression_for_exercise",
      "remove_exercise_from_day",
      "rename_day_template",
      "reorder_day_exercises",
      "scheme_history_for_day_exercise",
      "sets_for_exercise",
      "training_gaps",
      "weekly_volume",
    ]);

    await client.close();
  });

  it("rejects a tool call with a missing bearer token via a clear MCP-level error, not a stack trace or empty result", async () => {
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(baseUrl);
    await client.connect(transport);

    const result = await client.callTool({ name: "weekly_volume", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Missing bearer token") }]);

    await client.close();
  });

  it("rejects a tool call with an invalid bearer token via a clear MCP-level error", async () => {
    const client = await connectAs("not-a-real-token");

    const result = await client.callTool({ name: "training_gaps", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Invalid bearer token") }]);

    await client.close();
  });

  it("two different logged-in users each see only their own data through the same route", async () => {
    const clientA = await connectAs("token-a");
    const clientB = await connectAs("token-b");

    const [progressionA, setsA, weeklyA, gapsA, templatesA, historyA, schemeHistoryA, adherenceA] = await Promise.all([
      clientA.callTool({ name: "progression_for_exercise", arguments: { exercise_name: "bench" } }),
      clientA.callTool({ name: "sets_for_exercise", arguments: { exercise_name: "bench" } }),
      clientA.callTool({ name: "weekly_volume", arguments: {} }),
      clientA.callTool({ name: "training_gaps", arguments: {} }),
      clientA.callTool({ name: "get_day_templates", arguments: {} }),
      clientA.callTool({ name: "get_workout_history", arguments: {} }),
      clientA.callTool({ name: "scheme_history_for_day_exercise", arguments: { workout_day_id: "day-a", exercise_id: "ex-a" } }),
      clientA.callTool({ name: "adherence_for_day", arguments: {} }),
    ]);
    const [progressionB, setsB, weeklyB, gapsB, templatesB, historyB, schemeHistoryB, adherenceB] = await Promise.all([
      clientB.callTool({ name: "progression_for_exercise", arguments: { exercise_name: "bench" } }),
      clientB.callTool({ name: "sets_for_exercise", arguments: { exercise_name: "bench" } }),
      clientB.callTool({ name: "weekly_volume", arguments: {} }),
      clientB.callTool({ name: "training_gaps", arguments: {} }),
      clientB.callTool({ name: "get_day_templates", arguments: {} }),
      clientB.callTool({ name: "get_workout_history", arguments: {} }),
      clientB.callTool({ name: "scheme_history_for_day_exercise", arguments: { workout_day_id: "day-b", exercise_id: "ex-b" } }),
      clientB.callTool({ name: "adherence_for_day", arguments: {} }),
    ]);

    expect(progressionA.isError).not.toBe(true);
    expect(progressionB.isError).not.toBe(true);
    expect(setsA.isError).not.toBe(true);
    expect(setsB.isError).not.toBe(true);
    expect(templatesA.isError).not.toBe(true);
    expect(templatesB.isError).not.toBe(true);
    expect(historyA.isError).not.toBe(true);
    expect(historyB.isError).not.toBe(true);
    expect(schemeHistoryA.isError).not.toBe(true);
    expect(schemeHistoryB.isError).not.toBe(true);
    expect(adherenceA.isError).not.toBe(true);
    expect(adherenceB.isError).not.toBe(true);
    expect(progressionA.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-a"].progression_for_exercise, null, 2) }]);
    expect(progressionB.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-b"].progression_for_exercise, null, 2) }]);
    expect(setsA.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-a"].sets_for_exercise, null, 2) }]);
    expect(setsB.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-b"].sets_for_exercise, null, 2) }]);
    expect(weeklyA.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-a"].weekly_volume, null, 2) }]);
    expect(weeklyB.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-b"].weekly_volume, null, 2) }]);
    expect(gapsA.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-a"].training_gaps, null, 2) }]);
    expect(gapsB.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-b"].training_gaps, null, 2) }]);
    expect(templatesA.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-a"].get_day_templates, null, 2) }]);
    expect(templatesB.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-b"].get_day_templates, null, 2) }]);
    expect(historyA.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-a"].get_workout_history, null, 2) }]);
    expect(historyB.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-b"].get_workout_history, null, 2) }]);
    expect(schemeHistoryA.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-a"].scheme_history_for_day_exercise, null, 2) }]);
    expect(schemeHistoryB.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-b"].scheme_history_for_day_exercise, null, 2) }]);
    expect(adherenceA.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-a"].adherence_for_day, null, 2) }]);
    expect(adherenceB.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-b"].adherence_for_day, null, 2) }]);

    await clientA.close();
    await clientB.close();
  });

  it("adherence_for_day forwards no filters when called with no arguments", async () => {
    const client = await connectAs("token-a");

    await client.callTool({ name: "adherence_for_day", arguments: {} });

    expect(rpcCalls).toContainEqual({
      name: "adherence_for_day",
      args: { for_workout_day_id: null, start_date: null, end_date: null },
    });

    await client.close();
  });

  it("adherence_for_day forwards workout_day_id, start_date, and end_date filters to the RPC call", async () => {
    const client = await connectAs("token-a");

    await client.callTool({
      name: "adherence_for_day",
      arguments: { workout_day_id: "day-a", start_date: "2026-08-01", end_date: "2026-08-31" },
    });

    expect(rpcCalls).toContainEqual({
      name: "adherence_for_day",
      args: { for_workout_day_id: "day-a", start_date: "2026-08-01", end_date: "2026-08-31" },
    });

    await client.close();
  });

  it("adherence_for_day succeeds when the client omits the arguments field entirely", async () => {
    const client = await connectAs("token-a");

    const result = await client.callTool({ name: "adherence_for_day" });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-a"].adherence_for_day, null, 2) }]);

    await client.close();
  });

  it("scheme_history_for_day_exercise forwards workout_day_id and exercise_id to the RPC call", async () => {
    const client = await connectAs("token-a");

    await client.callTool({
      name: "scheme_history_for_day_exercise",
      arguments: { workout_day_id: "day-a", exercise_id: "ex-a" },
    });

    expect(rpcCalls).toContainEqual({
      name: "scheme_history_for_day_exercise",
      args: { workout_day_id: "day-a", exercise_id: "ex-a" },
    });

    await client.close();
  });

  it("get_workout_history forwards no filters when called with no arguments, preserving the full-dump default", async () => {
    const client = await connectAs("token-a");

    await client.callTool({ name: "get_workout_history", arguments: {} });

    expect(rpcCalls).toContainEqual({
      name: "get_workout_history",
      args: { start_date: null, end_date: null, exercise_name: null },
    });

    await client.close();
  });

  it("get_workout_history forwards start_date, end_date, and exercise_name filters to the RPC call", async () => {
    const client = await connectAs("token-a");

    await client.callTool({
      name: "get_workout_history",
      arguments: { start_date: "2026-08-01", end_date: "2026-08-31", exercise_name: "bench" },
    });

    expect(rpcCalls).toContainEqual({
      name: "get_workout_history",
      args: { start_date: "2026-08-01", end_date: "2026-08-31", exercise_name: "bench" },
    });

    await client.close();
  });

  it("get_workout_history succeeds when the client omits the arguments field entirely (spec-compliant, not just {})", async () => {
    const client = await connectAs("token-a");

    const result = await client.callTool({ name: "get_workout_history" });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(FIXTURES["user-a"].get_workout_history, null, 2) }]);

    await client.close();
  });

  it("writes the rotated refresh_token back so a session survives repeated calls after Supabase rotates it", async () => {
    const client = await connectAs("token-a");

    const first = await client.callTool({ name: "weekly_volume", arguments: {} });
    const second = await client.callTool({ name: "weekly_volume", arguments: {} });

    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);

    await client.close();
  });

  describe("day template write tools", () => {
    it("create_day_template creates a day owned by the caller and returns it", async () => {
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "create_day_template", arguments: { name: "Pull Day" } });

      expect(result.isError).not.toBe(true);
      const [content] = result.content as [{ type: "text"; text: string }];
      const day = JSON.parse(content.text);
      expect(day).toEqual({ id: expect.any(String), name: "Pull Day", position: 0, exerciseIds: [] });
      expect(TABLES.workout_days.find((d) => d.id === day.id)?.user_id).toBe("user-a");

      await client.close();
    });

    it("rename_day_template renames an existing day and returns it", async () => {
      seedDay("user-a", "day-a", "Push");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "rename_day_template", arguments: { day_id: "day-a", name: "Push (v2)" } });

      expect(result.isError).not.toBe(true);
      expect(TABLES.workout_days.find((d) => d.id === "day-a")?.name).toBe("Push (v2)");

      await client.close();
    });

    it("rename_day_template errors clearly on a nonexistent day id", async () => {
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "rename_day_template", arguments: { day_id: "no-such-day", name: "X" } });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "rename_day_template failed: Day template no-such-day not found." },
      ]);

      await client.close();
    });

    it("rename_day_template cannot rename another user's day", async () => {
      seedDay("user-b", "day-b", "Pull");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "rename_day_template", arguments: { day_id: "day-b", name: "Hijacked" } });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "rename_day_template failed: Day template day-b not found." },
      ]);
      expect(TABLES.workout_days.find((d) => d.id === "day-b")?.name).toBe("Pull");

      await client.close();
    });

    it("delete_day_template deletes an existing day and returns confirmation", async () => {
      seedDay("user-a", "day-a", "Push");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "delete_day_template", arguments: { day_id: "day-a" } });

      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify({ id: "day-a", name: "Push", deleted: true }, null, 2) },
      ]);
      expect(TABLES.workout_days.find((d) => d.id === "day-a")).toBeUndefined();

      await client.close();
    });

    it("delete_day_template cannot delete another user's day", async () => {
      seedDay("user-b", "day-b", "Pull");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "delete_day_template", arguments: { day_id: "day-b" } });

      expect(result.isError).toBe(true);
      expect(TABLES.workout_days.find((d) => d.id === "day-b")).toBeDefined();

      await client.close();
    });

    it("create_exercise creates a catalog exercise with defaults applied", async () => {
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "create_exercise", arguments: { name: "Overhead Press" } });

      expect(result.isError).not.toBe(true);
      const [content] = result.content as [{ type: "text"; text: string }];
      const exercise = JSON.parse(content.text);
      expect(exercise).toEqual({
        id: expect.any(String),
        name: "Overhead Press",
        cue: "",
        defaultSets: 3,
        defaultRepLow: 10,
        defaultRepHigh: 12,
      });

      await client.close();
    });

    it("create_exercise honors explicit optional fields", async () => {
      const client = await connectAs("token-a");

      const result = await client.callTool({
        name: "create_exercise",
        arguments: { name: "Deadlift", cue: "neutral spine", default_sets: 5, default_rep_low: 3, default_rep_high: 5 },
      });

      expect(result.isError).not.toBe(true);
      const [content] = result.content as [{ type: "text"; text: string }];
      expect(JSON.parse(content.text)).toEqual({
        id: expect.any(String),
        name: "Deadlift",
        cue: "neutral spine",
        defaultSets: 5,
        defaultRepLow: 3,
        defaultRepHigh: 5,
      });

      await client.close();
    });

    it("create_exercise rejects an out-of-range default_rep_high", async () => {
      const client = await connectAs("token-a");

      const result = await client.callTool({
        name: "create_exercise",
        arguments: { name: "Curl", default_rep_high: 41 },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "create_exercise failed: default_rep_high must be an integer between 1 and 40." },
      ]);

      await client.close();
    });

    it("add_exercise_to_day attaches an exercise the caller owns", async () => {
      seedDay("user-a", "day-a", "Push");
      seedExercise("user-a", "ex-a", "Bench Press");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "add_exercise_to_day", arguments: { day_id: "day-a", exercise_id: "ex-a" } });

      expect(result.isError).not.toBe(true);
      expect(TABLES.workout_day_exercises).toContainEqual(
        expect.objectContaining({ workout_day_id: "day-a", exercise_id: "ex-a", position: 0 }),
      );

      await client.close();
    });

    it("add_exercise_to_day rejects a duplicate attach without creating a second row", async () => {
      seedDay("user-a", "day-a", "Push");
      seedExercise("user-a", "ex-a", "Bench Press");
      seedDayExercise("user-a", "day-a", "ex-a", 0);
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "add_exercise_to_day", arguments: { day_id: "day-a", exercise_id: "ex-a" } });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "add_exercise_to_day failed: Exercise ex-a is already on day day-a." },
      ]);
      expect(TABLES.workout_day_exercises.filter((r) => r.workout_day_id === "day-a")).toHaveLength(1);

      await client.close();
    });

    it("add_exercise_to_day cannot attach another user's exercise to the caller's day", async () => {
      seedDay("user-a", "day-a", "Push");
      seedExercise("user-b", "ex-b", "Row");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "add_exercise_to_day", arguments: { day_id: "day-a", exercise_id: "ex-b" } });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "add_exercise_to_day failed: Exercise ex-b not found." },
      ]);

      await client.close();
    });

    it("remove_exercise_from_day detaches only the targeted exercise", async () => {
      seedDay("user-a", "day-a", "Push");
      seedExercise("user-a", "ex-a", "Bench Press");
      seedExercise("user-a", "ex-c", "Incline Press");
      seedDayExercise("user-a", "day-a", "ex-a", 0);
      seedDayExercise("user-a", "day-a", "ex-c", 1);
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "remove_exercise_from_day", arguments: { day_id: "day-a", exercise_id: "ex-a" } });

      expect(result.isError).not.toBe(true);
      expect(TABLES.workout_day_exercises.map((r) => r.exercise_id)).toEqual(["ex-c"]);

      await client.close();
    });

    it("remove_exercise_from_day cannot touch another user's day", async () => {
      seedDay("user-b", "day-b", "Pull");
      seedExercise("user-b", "ex-b", "Row");
      seedDayExercise("user-b", "day-b", "ex-b", 0);
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "remove_exercise_from_day", arguments: { day_id: "day-b", exercise_id: "ex-b" } });

      expect(result.isError).toBe(true);
      expect(TABLES.workout_day_exercises).toHaveLength(1);

      await client.close();
    });

    it("reorder_day_exercises rewrites order and preserves target_sets across the round-trip", async () => {
      seedDay("user-a", "day-a", "Push");
      seedExercise("user-a", "ex-a", "Bench Press");
      seedExercise("user-a", "ex-c", "Incline Press");
      seedDayExercise("user-a", "day-a", "ex-a", 0, [{ weight: 185, reps: 5 }]);
      seedDayExercise("user-a", "day-a", "ex-c", 1);
      const client = await connectAs("token-a");

      const result = await client.callTool({
        name: "reorder_day_exercises",
        arguments: { day_id: "day-a", exercise_ids: ["ex-c", "ex-a"] },
      });

      expect(result.isError).not.toBe(true);
      const rows = TABLES.workout_day_exercises
        .filter((r) => r.workout_day_id === "day-a")
        .sort((a, b) => (a.position as number) - (b.position as number));
      expect(rows.map((r) => r.exercise_id)).toEqual(["ex-c", "ex-a"]);
      expect(rows.find((r) => r.exercise_id === "ex-a")?.target_sets).toEqual([{ weight: 185, reps: 5 }]);

      await client.close();
    });

    it("reorder_day_exercises rejects a list missing a current member", async () => {
      seedDay("user-a", "day-a", "Push");
      seedExercise("user-a", "ex-a", "Bench Press");
      seedExercise("user-a", "ex-c", "Incline Press");
      seedDayExercise("user-a", "day-a", "ex-a", 0);
      seedDayExercise("user-a", "day-a", "ex-c", 1);
      const client = await connectAs("token-a");

      const result = await client.callTool({
        name: "reorder_day_exercises",
        arguments: { day_id: "day-a", exercise_ids: ["ex-a"] },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text:
            "reorder_day_exercises failed: exercise_ids missing [ex-c]. Use add_exercise_to_day/remove_exercise_from_day to change membership instead.",
        },
      ]);
      expect(TABLES.workout_day_exercises.filter((r) => r.workout_day_id === "day-a")).toHaveLength(2);

      await client.close();
    });

    it("reorder_day_exercises rejects a list with an id not on the day", async () => {
      seedDay("user-a", "day-a", "Push");
      seedExercise("user-a", "ex-a", "Bench Press");
      seedDayExercise("user-a", "day-a", "ex-a", 0);
      const client = await connectAs("token-a");

      const result = await client.callTool({
        name: "reorder_day_exercises",
        arguments: { day_id: "day-a", exercise_ids: ["ex-a", "ex-z"] },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text:
            "reorder_day_exercises failed: exercise_ids unexpected [ex-z]. Use add_exercise_to_day/remove_exercise_from_day to change membership instead.",
        },
      ]);

      await client.close();
    });
  });
});
