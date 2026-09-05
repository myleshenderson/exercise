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
      "adherence_for_day",
      "get_day_templates",
      "get_workout_history",
      "progression_for_exercise",
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
      "adherence_for_day",
      "get_day_templates",
      "get_workout_history",
      "progression_for_exercise",
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
});
