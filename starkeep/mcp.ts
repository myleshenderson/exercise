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
import type { McpRequestContext } from "./mcp-auth.js";

/** The MCP `serverInfo.name` a client sees after `initialize`. */
export const MCP_SERVER_NAME = "exercise";
export const MCP_SERVER_VERSION = "0.1.0";

/**
 * What the server needs to answer tool calls. `context` is who the request
 * acts for, resolved by `mcp-auth.ts` from the bearer token: the tool handlers
 * (AI-604) build `createServerTransport({ userToken: context.userToken })`
 * from it per request. No tools yet: AI-604 calls
 * `registerTools(server, handlers)` from `src/mcp/` inside
 * {@link createExerciseMcpServer}.
 */
export interface ExerciseMcpDeps {
  context?: McpRequestContext;
}

export function createExerciseMcpServer(_deps: ExerciseMcpDeps = {}): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

  // McpServer only installs its `tools/list` and `tools/call` handlers (and
  // advertises the `tools` capability) when the first tool is registered. With
  // no tools a client's `tools/list` would get "Method not found" instead of an
  // empty list. Registering and immediately removing a placeholder installs the
  // handlers through the SDK's own path, so a later `registerTool` call keeps
  // working; setting the handlers by hand would make that call throw
  // "handler for tools/list already exists".
  server.registerTool("__init", { description: "placeholder" }, () => ({ content: [] })).remove();

  return server;
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
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    // The JSON response body is fully built by now, so closing cannot cut it
    // short; it releases the per-request server and transport.
    await transport.close();
    await server.close();
  }
}
