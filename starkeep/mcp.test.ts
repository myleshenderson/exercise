// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeDataPlane, TEST_CREDS } from "./test-support.js";

vi.mock("@starkeep/app-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@starkeep/app-client")>();
  return { ...actual, loadAppCredentials: async () => TEST_CREDS };
});

const { createApp } = await import("./server.js");

// Local mode: a sealed token whose row lives in a fake data plane.
const plane = new FakeDataPlane();
const { token: TOKEN } = plane.seed();
const app = createApp();

beforeAll(() => {
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  vi.stubGlobal("fetch", plane.fetch);
});
afterAll(() => vi.unstubAllGlobals());

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
