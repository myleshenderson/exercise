// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createApp } from "./server.js";
import { bearerToken, tokensMatch } from "./mcp-auth.js";

const TOKEN = "s3cret-token";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

function post(app: ReturnType<typeof createApp>, headers: Record<string, string> = {}) {
  return app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(initialize),
  });
}

describe("POST /mcp bearer token", () => {
  const app = createApp({ mcpToken: TOKEN });

  it("missing Authorization header → 401", async () => {
    const res = await post(app);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("wrong token → 401", async () => {
    const res = await post(app, { authorization: "Bearer not-the-token" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("non-Bearer scheme → 401", async () => {
    const res = await post(app, { authorization: `Basic ${TOKEN}` });
    expect(res.status).toBe(401);
  });

  it("right token → passes to the MCP transport", async () => {
    const res = await post(app, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
  });

  it("token env unset → 503, even with a header", async () => {
    for (const mcpToken of [undefined, ""]) {
      const res = await post(createApp({ mcpToken }), { authorization: "Bearer anything" });
      expect(res.status).toBe(503);
    }
  });

  it("GET /mcp → 405", async () => {
    const res = await app.request("/mcp", { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("token helpers", () => {
  it("parses only a single-token Bearer header", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer a b")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it("compares tokens of different lengths without throwing", () => {
    expect(tokensMatch("a", "a")).toBe(true);
    expect(tokensMatch("a", "ab")).toBe(false);
  });
});
