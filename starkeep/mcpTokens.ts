/**
 * The few `mcp_tokens` row calls the token endpoints need (`/mcp` auth,
 * `/api/mcp-login`, `/api/mcp-sessions`), as thin wrappers over the shared
 * row client in `src/data/starkeep/rows.ts`. The caller passes a per-request
 * {@link Transport} (normally `createServerTransport({ userToken })`).
 *
 * Every call throws {@link RowApiError} on a non-2xx answer; callers map that
 * to their own response.
 */

import { createRowClient, RowApiError, tablePath, type Transport } from "../src/data/starkeep/rows.js";

export { RowApiError };

const MCP_TOKENS = "mcp_tokens";

export const MCP_TOKENS_PATH = tablePath(MCP_TOKENS);

export interface McpTokenRow {
  id: string;
  token_hash: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
}

export async function findTokenRow(transport: Transport, id: string): Promise<McpTokenRow | null> {
  const page = await createRowClient(transport).select<McpTokenRow & Record<string, unknown>>(MCP_TOKENS, {
    where: { id },
    limit: 1,
  });
  return page.rows[0] ?? null;
}

/** Every row the caller can see, newest first. */
export async function listTokenRows(transport: Transport): Promise<McpTokenRow[]> {
  return createRowClient(transport).selectAll<McpTokenRow & Record<string, unknown>>(MCP_TOKENS, {
    order: ["created_at.desc", "id.asc"],
  });
}

export async function insertTokenRow(transport: Transport, row: McpTokenRow): Promise<void> {
  await createRowClient(transport).insert(MCP_TOKENS, { ...row });
}

/** Number of rows deleted. */
export async function deleteTokenRow(transport: Transport, id: string): Promise<number> {
  return createRowClient(transport).remove(MCP_TOKENS, { id });
}

export async function touchTokenRow(transport: Transport, id: string, at: string): Promise<void> {
  await createRowClient(transport).patch(MCP_TOKENS, { id }, { last_used_at: at });
}
