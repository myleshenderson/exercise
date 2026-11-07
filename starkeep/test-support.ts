/**
 * Test doubles shared by the token tests (not a test file itself).
 *
 * `FakeDataPlane` stands in for the data server behind `signedFetch`: it is
 * installed as the global `fetch`, answers the `mcp_tokens` row API
 * (`GET ?where={"id":…}` / list with `order`, `POST { row }`,
 * `PATCH { where, patch }`, `DELETE { where }`), and records every request.
 * Rows are owned by the `X-Starkeep-User-Token` they were written with (or by
 * nobody, locally), and a caller only sees its own, which is how the cloud
 * data plane scopes them.
 */

import { randomUUID } from "node:crypto";
import type { AppCredentials } from "@starkeep/app-client";
import type { McpTokenRow } from "./mcpTokens.js";
import { sealToken, tokenIdHash } from "./token.js";

export const TEST_SECRET = "test-hmac-secret";
export const TEST_CREDS: AppCredentials = {
  appId: "exercise",
  hmacSecret: TEST_SECRET,
  dataServerUrl: "http://data.test",
};

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

interface StoredRow extends McpTokenRow {
  owner: string | null;
}

export class FakeDataPlane {
  rows: StoredRow[] = [];
  requests: RecordedRequest[] = [];
  /** Status to answer every request with instead of serving it. */
  failWith: number | null = null;
  /** Maps an `X-Starkeep-User-Token` to the owner its rows belong to. */
  ownerOf: (userToken: string | undefined) => string | null = (t) => t ?? null;

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path: url.pathname + url.search, headers, body });
    if (this.failWith) return Response.json({ error: "boom" }, { status: this.failWith });
    if (url.pathname !== "/app-data/db/mcp_tokens") return Response.json({ error: "no route" }, { status: 404 });

    const owner = this.ownerOf(headers["x-starkeep-user-token"]);
    const mine = this.rows.filter((r) => r.owner === owner);
    const matches = (r: StoredRow, where: Record<string, unknown>) =>
      Object.entries(where).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v);
    const strip = ({ owner: _owner, ...row }: StoredRow): McpTokenRow => row;

    if (method === "GET") {
      const where = JSON.parse(url.searchParams.get("where") ?? "{}") as Record<string, unknown>;
      let rows = mine.filter((r) => matches(r, where));
      if (url.searchParams.get("order")?.startsWith("created_at.desc")) {
        rows = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
      }
      const limit = Number(url.searchParams.get("limit") ?? 30);
      return Response.json({ rows: rows.slice(0, limit).map(strip), truncated: false, page_token: null });
    }
    if (method === "POST") {
      this.rows.push({ ...(body.row as McpTokenRow), owner });
      return Response.json({ ok: true });
    }
    if (method === "PATCH") {
      const hit = mine.filter((r) => matches(r, body.where));
      for (const r of hit) Object.assign(r, body.patch);
      return Response.json({ changes: hit.length });
    }
    if (method === "DELETE") {
      const hit = new Set(mine.filter((r) => matches(r, body.where)));
      this.rows = this.rows.filter((r) => !hit.has(r));
      return Response.json({ changes: hit.size });
    }
    return Response.json({ error: "method" }, { status: 405 });
  };

  /** Insert a row directly and return the matching sealed token. */
  seed(
    opts: { expiresAt?: string; lastUsedAt?: string | null; owner?: string | null; rt?: string | null; sub?: string | null } = {},
  ): { id: string; token: string } {
    const id = randomUUID();
    this.rows.push({
      id,
      token_hash: tokenIdHash(id),
      label: null,
      created_at: new Date().toISOString(),
      last_used_at: opts.lastUsedAt ?? null,
      expires_at: opts.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
      owner: opts.owner ?? null,
    });
    const token = sealToken({ v: 1, id, rt: opts.rt ?? null, sub: opts.sub ?? null }, TEST_SECRET);
    return { id, token };
  }

  requestsTo(method: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method);
  }
}

/** An unsigned JWT-shaped string carrying `exp` (seconds) and `sub`. */
export function fakeJwt(claims: { exp: number; sub: string }): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(claims)}.sig`;
}

export const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

export function mcpHeaders(token?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}
