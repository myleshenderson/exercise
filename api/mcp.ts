import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Vercel's Node runtime pre-parses JSON request bodies onto req.body before
// invoking the handler; the SDK's Node types don't know about that.
type VercelRequest = IncomingMessage & { body?: unknown };

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "exercise-mcp", version: "0.1.0" });

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description:
        "No-op placeholder tool that confirms the MCP route is reachable. Real tools land in a later task.",
    },
    async () => ({
      content: [{ type: "text" as const, text: "pong" }],
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
  const server = createMcpServer();
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
