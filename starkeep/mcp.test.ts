// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createApp } from "./server.js";

const TOKEN = "s3cret-token";
const app = createApp({ mcpToken: TOKEN });

async function rpc(body: unknown) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  return (await res.json()) as { jsonrpc: string; id: number; result?: Record<string, unknown>; error?: unknown };
}

describe("POST /mcp (stateless JSON transport)", () => {
  it("answers initialize with protocolVersion and serverInfo.name 'exercise'", async () => {
    const reply = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toMatchObject({ protocolVersion: expect.any(String), serverInfo: { name: "exercise" } });
  });

  it("answers tools/list with an empty tools array", async () => {
    const reply = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toMatchObject({ tools: [] });
  });
});
