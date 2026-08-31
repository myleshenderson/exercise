import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requiredEnv } from "./_env.js";
import { resolveIdentity, type IdentityResult } from "./mcp-auth.js";

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
      const authClient = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
      identityPromise = resolveIdentity(bearerToken, { client: authClient });
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
  await transport.handleRequest(req, res, req.body);
}
