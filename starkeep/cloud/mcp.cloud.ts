/**
 * Exercise's `/mcp` on a real Starkeep cloud: the throwaway AWS test stack
 * that core's tier-3 harness deploys (`setup.ts`).
 *
 * What it proves, against the deployed gateway, Lambda and data plane:
 *
 * - A request without a token gets the gateway's 401, and the route's
 *   protected resource metadata names the deployment's authorization server.
 *   That is what an MCP client needs to start OAuth sign-in.
 * - A `readwrite` delegation lists the 32 tools, writes, and reads its write.
 * - A `read` delegation reads, and the platform refuses its write.
 * - A token the deployment did not sign gets 401.
 *
 * The OAuth sign-in itself is the platform's, and core's tier-3 run drives it
 * against its own fixture app. The tokens here come from the platform's
 * `/connect` page, which issues the same kind of delegation.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readCloudRun } from "./run-step.js";

const run = readCloudRun();

interface ToolReply {
  content: { type: string; text: string }[];
  isError?: boolean;
}

describe.skipIf(!run.enabled)("Exercise /mcp on a cloud test stack", () => {
  if (!run.enabled) return;
  const mcpUrl = `${run.appUrl}mcp`;
  const edge = new URL(run.appUrl).origin;
  let rpcId = 0;

  function post(body: unknown, token?: string): Promise<Response> {
    return fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function rpc(method: string, params: unknown, token: string): Promise<Record<string, unknown>> {
    const res = await post({ jsonrpc: "2.0", id: ++rpcId, method, params }, token);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
    expect(body.error).toBeUndefined();
    return body.result!;
  }

  const callTool = async (name: string, args: Record<string, unknown>, token: string) =>
    (await rpc("tools/call", { name, arguments: args }, token)) as unknown as ToolReply;

  async function exerciseNames(token: string): Promise<string[]> {
    const reply = await callTool("list_exercises", {}, token);
    expect(reply.isError, reply.content[0]?.text).toBeUndefined();
    return (JSON.parse(reply.content[0]!.text) as { name: string }[]).map((e) => e.name);
  }

  it("answers a request without a token with the gateway's 401", async () => {
    const res = await post({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} });
    expect(res.status).toBe(401);
  });

  it("serves the protected resource metadata that names the deployment's authorization server", async () => {
    const prm = await fetch(`${edge}/.well-known/oauth-protected-resource/apps/${run.appId}/mcp`);
    expect(prm.status).toBe(200);
    const resource = (await prm.json()) as { resource: string; authorization_servers: string[] };
    expect(resource.resource).toBe(mcpUrl);
    expect(resource.authorization_servers).toEqual([run.gatewayUrl]);

    const as = await fetch(`${run.gatewayUrl}/.well-known/oauth-authorization-server`);
    expect(as.status).toBe(200);
    expect(await as.json()).toMatchObject({ issuer: run.gatewayUrl });
  });

  it("lists the 32 tools, writes and reads its write under a readwrite delegation", async () => {
    const token = run.delegationTokens.readwrite;
    const list = (await rpc("tools/list", {}, token)) as { tools: unknown[] };
    expect(list.tools).toHaveLength(32);

    const name = `Cloud Press ${randomUUID().slice(0, 8)}`;
    const created = await callTool("create_exercise", { name }, token);
    expect(created.isError, created.content[0]?.text).toBeUndefined();
    expect(await exerciseNames(token)).toContain(name);
  });

  it("reads under a read delegation, and the platform refuses its write", async () => {
    const token = run.delegationTokens.read;
    expect(await exerciseNames(token)).toContain("Leg Press");

    const name = `Refused Press ${randomUUID().slice(0, 8)}`;
    const refused = await callTool("create_exercise", { name }, token);
    expect(refused.isError).toBe(true);
    expect(await exerciseNames(run.delegationTokens.readwrite)).not.toContain(name);
  });

  it("answers a token the deployment did not sign with 401", async () => {
    const res = await post({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} }, "skd_not-a-real-token");
    expect(res.status).toBe(401);
  });
});
