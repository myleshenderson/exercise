/**
 * The exercise MCP server, as Starkeep serves it at `POST /mcp`.
 *
 * Same transport contract as `api/mcp.ts` (the Vercel function): stateless
 * (`sessionIdGenerator: undefined`), JSON responses rather than an SSE stream
 * (`enableJsonResponse: true`), and a fresh server + transport per request.
 * Starkeep's Lambda adapter buffers the whole response, so SSE would never
 * reach the client.
 *
 * `api/mcp.ts` uses `StreamableHTTPServerTransport`, which is the SDK's Node
 * `IncomingMessage`/`ServerResponse` wrapper around
 * `WebStandardStreamableHTTPServerTransport`. Hono hands us a web `Request` on
 * both surfaces (Node locally, Lambda in the cloud), so this uses the web
 * standard class directly with identical options.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createStarkeepDataLayer } from "../src/data/starkeep.js";
import { createRowClient } from "../src/data/starkeep/rows.js";
import { withDefaultToolArguments } from "../src/mcp/defaults.js";
import { registerTools, type McpToolHandlers } from "../src/mcp/handlers.js";
import { toolError } from "../src/mcp/format.js";
import { TOOL_DEFINITIONS } from "../src/mcp/tools.js";
import { createStarkeepHandlers } from "./handlers.js";
import type { McpRequestContext } from "./mcp-auth.js";
import { createServerTransport } from "./serverTransport.js";

/** The MCP `serverInfo.name` a client sees after `initialize`. */
export const MCP_SERVER_NAME = "exercise";
export const MCP_SERVER_VERSION = "0.1.0";

/**
 * What the server needs to answer tool calls. `context` is who the request
 * acts for, resolved by `mcp-auth.ts` from the bearer token. Without it every
 * tool answers `unauthenticated`; there is no shared fallback client.
 */
export interface ExerciseMcpDeps {
  context?: McpRequestContext;
}

/** Every tool answering `unauthenticated`: what a request with no context gets. */
function unauthenticatedHandlers(): McpToolHandlers {
  const deny = async () => toolError("unauthenticated");
  return Object.fromEntries(TOOL_DEFINITIONS.map(({ name }) => [name, deny])) as unknown as McpToolHandlers;
}

/**
 * The tool handlers for one request: a transport carrying that request's user
 * token, a row client and a DataLayer over it. Built per request and never
 * cached, so two requests can never share a transport (and so a user token).
 */
export function createRequestHandlers(deps: ExerciseMcpDeps): McpToolHandlers {
  const { context } = deps;
  if (!context) return unauthenticatedHandlers();
  // Signs each row request with the app credential and, in the cloud, sends
  // context.userToken as X-Starkeep-User-Token; locally it is undefined.
  const transport = createServerTransport({ userToken: context.userToken });
  return createStarkeepHandlers(createStarkeepDataLayer(transport), createRowClient(transport));
}

export function createExerciseMcpServer(deps: ExerciseMcpDeps = {}): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  registerTools(server, createRequestHandlers(deps));
  return server;
}

/** The parsed JSON body, or undefined to let the transport read (and reject) it itself. */
async function parsedBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json")) return undefined;
  try {
    return withDefaultToolArguments(await request.clone().json());
  } catch {
    return undefined;
  }
}

/** Answer one MCP POST with a fresh, stateless server + transport. */
export async function handleMcpRequest(
  request: Request,
  deps: ExerciseMcpDeps = {},
): Promise<Response> {
  const server = createExerciseMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    const body = await parsedBody(request);
    await server.connect(transport);
    return await transport.handleRequest(request, body === undefined ? undefined : { parsedBody: body });
  } finally {
    // The JSON response body is fully built by now, so closing cannot cut it
    // short; it releases the per-request server and transport.
    await transport.close();
    await server.close();
  }
}
