/**
 * The few `mcp_tokens` row calls the token endpoints need, over a
 * {@link Transport}. AI-591's general row client (`src/data/starkeep/rows.ts`)
 * is not on `main` yet, so these speak the data server's row API directly
 * (authoring guide §6a): `GET ?where=&order=&limit=&page_token=`,
 * `POST { row }`, `PATCH { where, patch }` → `{ changes }`,
 * `DELETE { where }` → `{ changes }`.
 *
 * Every call throws {@link RowApiError} on a non-2xx answer; callers map that
 * to their own response.
 */

import type { Transport } from "./serverTransport.js";

export const MCP_TOKENS_PATH = "/app-data/db/mcp_tokens";

export interface McpTokenRow {
  id: string;
  token_hash: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
}

export class RowApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RowApiError";
  }
}

async function call<T>(transport: Transport, path: string, init: RequestInit): Promise<T> {
  const res = await transport(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new RowApiError(res.status, `mcp_tokens ${init.method ?? "GET"} → ${res.status} ${text}`.trim());
  }
  return (await res.json()) as T;
}

interface Page {
  rows: McpTokenRow[];
  truncated: boolean;
  page_token: string | null;
}

export async function findTokenRow(transport: Transport, id: string): Promise<McpTokenRow | null> {
  const qs = new URLSearchParams({ where: JSON.stringify({ id }), limit: "1" });
  const page = await call<Page>(transport, `${MCP_TOKENS_PATH}?${qs}`, { method: "GET" });
  return page.rows[0] ?? null;
}

/** Every row the caller can see, newest first. */
export async function listTokenRows(transport: Transport): Promise<McpTokenRow[]> {
  const rows: McpTokenRow[] = [];
  let pageToken: string | null = null;
  do {
    const qs = new URLSearchParams({ order: "created_at.desc,id.asc", limit: "500" });
    if (pageToken) qs.set("page_token", pageToken);
    const page: Page = await call<Page>(transport, `${MCP_TOKENS_PATH}?${qs}`, { method: "GET" });
    rows.push(...page.rows);
    pageToken = page.truncated ? page.page_token : null;
  } while (pageToken);
  return rows;
}

export async function insertTokenRow(transport: Transport, row: McpTokenRow): Promise<void> {
  await call(transport, MCP_TOKENS_PATH, { method: "POST", body: JSON.stringify({ row }) });
}

/** Number of rows deleted. */
export async function deleteTokenRow(transport: Transport, id: string): Promise<number> {
  const out = await call<{ changes?: number }>(transport, MCP_TOKENS_PATH, {
    method: "DELETE",
    body: JSON.stringify({ where: { id } }),
  });
  return out.changes ?? 0;
}

export async function touchTokenRow(transport: Transport, id: string, at: string): Promise<void> {
  await call(transport, MCP_TOKENS_PATH, {
    method: "PATCH",
    body: JSON.stringify({ where: { id }, patch: { last_used_at: at } }),
  });
}
