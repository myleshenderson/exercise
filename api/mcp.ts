import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requiredEnv } from "./_env.js";
import { resolveIdentity, type IdentityResult } from "./mcp-auth.js";
import { createDay, updateDayName, deleteDay } from "../src/data/supabase.js";

// Vercel's Node runtime pre-parses JSON request bodies onto req.body before
// invoking the handler; the SDK's Node types don't know about that.
type VercelRequest = IncomingMessage & { body?: unknown };

function extractBearerToken(req: VercelRequest): string | undefined {
  const header = req.headers.authorization;
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  return match?.[1];
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function toolResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// The MCP spec makes a tools/call request's `arguments` field optional, so a
// spec-compliant client calling a tool whose schema is all-optional fields (e.g.
// get_workout_history's filters) may omit it entirely rather than sending `{}`.
// The SDK's zod-based validation requires an actual object once a tool has any
// inputSchema, though, and rejects `undefined` even when every field is optional -
// so default it here before it reaches that validation. Handles both a single
// JSON-RPC message and a batched array of them.
function withDefaultToolArguments(body: unknown): unknown {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (message && typeof message === "object" && (message as Record<string, unknown>).method === "tools/call") {
      const params = (message as Record<string, unknown>).params;
      if (params && typeof params === "object" && (params as Record<string, unknown>).arguments === undefined) {
        (params as Record<string, unknown>).arguments = {};
      }
    }
  }
  return body;
}

// apikey only gates Supabase's API gateway; the Postgres role PostgREST assumes comes
// from the Authorization JWT. Presenting the resolved user's access_token there (while
// apikey stays the service-role key) makes auth.uid() and RLS on the security-invoker
// RPC functions scope every result to that user alone.
function createUserScopedClient(accessToken: string): SupabaseClient {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function findDay(
  client: SupabaseClient,
  dayId: string,
): Promise<{ id: string; name: string; position: number } | null> {
  const { data } = await client.from("workout_days").select("id, name, position").eq("id", dayId).maybeSingle();
  return (data as { id: string; name: string; position: number } | null) ?? null;
}

function createMcpServer(bearerToken: string | undefined): McpServer {
  const server = new McpServer({ name: "exercise-mcp", version: "0.1.0" });

  // Resolved lazily, on the first tool call, rather than eagerly for every request:
  // initialize and tools/list never need a user identity (and shouldn't need Supabase
  // env configured to succeed), and resolving one rotates the caller's stored
  // refresh_token — so doing it eagerly would burn a rotation for requests that never
  // needed one. Memoized so that if a single invocation calls more than one tool (e.g.
  // a batched JSON-RPC request), they share one resolution instead of each rotating
  // the refresh_token out from under the others.
  let identityPromise: Promise<IdentityResult> | undefined;
  function getIdentity(): Promise<IdentityResult> {
    if (!identityPromise) {
      const url = requiredEnv("SUPABASE_URL");
      const key = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
      // Two separate client instances, not one shared: resolveIdentity calls
      // .auth.refreshSession() on authClient, which would otherwise silently swap
      // the service-role identity for the refreshed user's on every subsequent
      // .from() call on the same client (see mcp-auth.ts's AuthDeps comment).
      identityPromise = resolveIdentity(bearerToken, {
        client: createClient(url, key),
        authClient: createClient(url, key),
      });
    }
    return identityPromise;
  }

  async function withIdentity(run: (accessToken: string) => Promise<CallToolResult>): Promise<CallToolResult> {
    const identity = await getIdentity();
    if (!identity.ok) return toolError(identity.error);
    return run(identity.accessToken);
  }

  server.registerTool(
    "progression_for_exercise",
    {
      title: "Progression for exercise",
      description:
        "Per-session set count, top weight, and volume for an exercise (matched by partial name), for the authenticated user.",
      inputSchema: { exercise_name: z.string() },
    },
    async ({ exercise_name }) =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("progression_for_exercise", {
          exercise_name,
        });
        if (error) return toolError(`progression_for_exercise failed: ${error.message}`);
        return toolResult(data);
      }),
  );

  server.registerTool(
    "sets_for_exercise",
    {
      title: "Sets for exercise",
      description:
        "Every individual logged set for an exercise (matched by partial name), ungrouped — performed_on, set_number, weight, and reps — for the authenticated user.",
      inputSchema: { exercise_name: z.string() },
    },
    async ({ exercise_name }) =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("sets_for_exercise", {
          exercise_name,
        });
        if (error) return toolError(`sets_for_exercise failed: ${error.message}`);
        return toolResult(data);
      }),
  );

  server.registerTool(
    "weekly_volume",
    {
      title: "Weekly volume",
      description: "Sessions and total volume per week for the authenticated user.",
    },
    async () =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("weekly_volume");
        if (error) return toolError(`weekly_volume failed: ${error.message}`);
        return toolResult(data);
      }),
  );

  server.registerTool(
    "training_gaps",
    {
      title: "Training gaps",
      description: "Days elapsed between consecutive training sessions for the authenticated user.",
    },
    async () =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("training_gaps");
        if (error) return toolError(`training_gaps failed: ${error.message}`);
        return toolResult(data);
      }),
  );

  server.registerTool(
    "get_day_templates",
    {
      title: "Day templates",
      description:
        "The authenticated user's day templates with their ordered exercises and each exercise's day-specific progressive scheme, or its uniform defaults when none is set.",
    },
    async () =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("get_day_templates");
        if (error) return toolError(`get_day_templates failed: ${error.message}`);
        return toolResult(data);
      }),
  );

  server.registerTool(
    "get_workout_history",
    {
      title: "Workout history",
      description:
        "The authenticated user's full raw session history: every session with its date, associated day, and every logged set, unaggregated. Optionally filter by date range (start_date/end_date) and/or a partial exercise-name match; omit all filters for the full history.",
      inputSchema: {
        start_date: z.string().optional().describe("Only include sessions performed on or after this date (YYYY-MM-DD)."),
        end_date: z.string().optional().describe("Only include sessions performed on or before this date (YYYY-MM-DD)."),
        exercise_name: z.string().optional().describe("Only include sets for exercises whose name partially matches this (case-insensitive)."),
      },
    },
    async ({ start_date, end_date, exercise_name }) =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("get_workout_history", {
          start_date: start_date ?? null,
          end_date: end_date ?? null,
          exercise_name: exercise_name ?? null,
        });
        if (error) return toolError(`get_workout_history failed: ${error.message}`);
        return toolResult(data);
      }),
  );

  server.registerTool(
    "scheme_history_for_day_exercise",
    {
      title: "Scheme history for day/exercise",
      description:
        "Every recorded progressive-scheme version for a (workout_day_id, exercise_id) pair, ordered by recorded_at, for the authenticated user — use a <= filter on recorded_at and take the latest row to find which scheme was in effect at or before a given date.",
      inputSchema: { workout_day_id: z.string(), exercise_id: z.string() },
    },
    async ({ workout_day_id, exercise_id }) =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("scheme_history_for_day_exercise", {
          workout_day_id,
          exercise_id,
        });
        if (error) return toolError(`scheme_history_for_day_exercise failed: ${error.message}`);
        return toolResult(data);
      }),
  );

  server.registerTool(
    "adherence_for_day",
    {
      title: "Adherence for day",
      description:
        "Compares the authenticated user's actual logged sets against the prescribed target for the same (day, exercise) pairing and session date - the scheme actually in effect on that date (via point-in-time history), falling back to the exercise's uniform defaults when no scheme was ever defined. Flags under-/over-shooting on sets, reps, and weight. Optionally filter by workout_day_id and/or a date range (start_date/end_date); omit all filters for every day and date.",
      inputSchema: {
        workout_day_id: z.string().optional().describe("Only include sessions for this workout day."),
        start_date: z.string().optional().describe("Only include sessions performed on or after this date (YYYY-MM-DD)."),
        end_date: z.string().optional().describe("Only include sessions performed on or before this date (YYYY-MM-DD)."),
      },
    },
    async ({ workout_day_id, start_date, end_date }) =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("adherence_for_day", {
          for_workout_day_id: workout_day_id ?? null,
          start_date: start_date ?? null,
          end_date: end_date ?? null,
        });
        if (error) return toolError(`adherence_for_day failed: ${error.message}`);
        return toolResult(data);
      }),
  );

  server.registerTool(
    "create_day_template",
    {
      title: "Create day template",
      description: "Creates a new, empty day template for the authenticated user. Returns the new day, including its id.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) =>
      withIdentity(async (accessToken) => {
        const day = await createDay(createUserScopedClient(accessToken), name);
        return toolResult(day);
      }),
  );

  server.registerTool(
    "rename_day_template",
    {
      title: "Rename day template",
      description: "Renames an existing day template belonging to the authenticated user, targeted by id.",
      inputSchema: { day_id: z.string(), name: z.string() },
    },
    async ({ day_id, name }) =>
      withIdentity(async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`rename_day_template failed: Day template ${day_id} not found.`);
        await updateDayName(client, day_id, name);
        return toolResult({ id: day.id, name, position: day.position });
      }),
  );

  server.registerTool(
    "delete_day_template",
    {
      title: "Delete day template",
      description:
        "Hard-deletes a day template belonging to the authenticated user, targeted by id. Its exercise attachments cascade-delete; any session that referenced this day keeps its history with workout_day_id set to null.",
      inputSchema: { day_id: z.string() },
    },
    async ({ day_id }) =>
      withIdentity(async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`delete_day_template failed: Day template ${day_id} not found.`);
        await deleteDay(client, day_id);
        return toolResult({ id: day.id, name: day.name, deleted: true });
      }),
  );

  return server;
}

export default async function handler(req: VercelRequest, res: ServerResponse): Promise<void> {
  // The standalone GET stream is for server-initiated notifications over a
  // long-lived connection, which doesn't fit a serverless function's
  // per-invocation lifetime. Reject it instead of hanging until the
  // platform's function timeout kills the invocation.
  if (req.method === "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end();
    return;
  }

  // Stateless per the SDK's serverless pattern: a fresh server + transport
  // per invocation, since Vercel gives no guarantee of process reuse between
  // requests and a stateless transport can't be reused across requests anyway.
  const server = createMcpServer(extractBearerToken(req));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Return the JSON-RPC response directly instead of opening an SSE
    // stream, since a serverless invocation ends once the response is sent.
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, withDefaultToolArguments(req.body));
}
