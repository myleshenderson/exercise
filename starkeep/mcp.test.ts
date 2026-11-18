// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mcpHeaders, TEST_CREDS } from "./test-support.js";

// tools/list as api/mcp.ts returned it on main, committed by AI-589.
const MAIN_TOOLS_LIST: unknown = JSON.parse(
  readFileSync(new URL("../src/mcp/__fixtures__/tools-list.main.json", import.meta.url), "utf8"),
);

vi.mock("@starkeep/app-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@starkeep/app-client")>();
  return { ...actual, loadAppCredentials: async () => TEST_CREDS };
});

const { createApp } = await import("./server.js");

// Local mode: `verifyDelegation` admits a loopback caller with no token, and
// neither initialize nor tools/list reads a row.
const app = createApp();

beforeAll(() => {
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  vi.stubGlobal("fetch", async () => {
    throw new Error("initialize and tools/list must not reach the data server");
  });
});
afterAll(() => vi.unstubAllGlobals());

async function rpc(body: unknown) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: mcpHeaders(),
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

  it("answers tools/list with the 32 tools, equal to the AI-589 fixture of main's tools/list", async () => {
    const reply = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(reply.error).toBeUndefined();
    expect((reply.result as { tools: unknown[] }).tools).toHaveLength(32);
    expect(reply.result).toEqual(MAIN_TOOLS_LIST);
  });
});
