import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import handler from "./mcp";

// Mimics Vercel's Node function contract: JSON request bodies arrive
// pre-parsed on req.body before the handler runs.
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

  it("completes initialize, tools/list, and tools/call over a real MCP client", async () => {
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(baseUrl);

    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("ping");

    const result = await client.callTool({ name: "ping", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);

    await client.close();
  });

  it("rejects GET with 405 instead of opening a long-lived stream a serverless invocation can't sustain", async () => {
    const response = await fetch(baseUrl, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
    });
    expect(response.status).toBe(405);
  });
});
