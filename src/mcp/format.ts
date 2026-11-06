import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Response and error formatting shared by every MCP backend, so the Vercel/Supabase
// server and Starkeep produce byte-identical tool output. Moved verbatim from
// api/mcp.ts (AI-589); change the text here only together with api/mcp.test.ts.

export function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function toolResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every *_id parameter on these tools targets a Postgres `uuid` column (see
// supabase/migrations/0001_init.sql), so a non-UUID value can never match a row. Rejecting
// it up front lets us say so plainly, instead of running the lookup and reporting a
// misleading "not found" for what's actually a malformed argument (e.g. a name passed
// where an id was expected).
export function invalidIdError(toolName: string, paramName: string, value: string): CallToolResult | undefined {
  if (UUID_PATTERN.test(value)) return undefined;
  return toolError(`${toolName} failed: expected a UUID for ${paramName}, got "${value}".`);
}

// The write tools' error wrapping: anything a write handler throws (a supabase-js
// PostgrestError, a plain Error, or a bare string) becomes a tool error reading
// "<tool> failed: <message>" rather than a JSON-RPC-level failure.
export async function catchToolError(toolName: string, run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (e) {
    const message = e instanceof Error ? e.message : ((e as { message?: string })?.message ?? String(e));
    return toolError(`${toolName} failed: ${message}`);
  }
}

export function validateReps(value: number): string | undefined {
  if (!Number.isInteger(value) || value < 1 || value > 40) return "must be an integer between 1 and 40.";
  return undefined;
}

export function validateWeight(value: number): string | undefined {
  if (!(value >= 0 && value <= 500)) return "must be between 0 and 500.";
  return undefined;
}

export function validateSets(value: number): string | undefined {
  if (!Number.isInteger(value) || value < 1 || value > 10) return "must be an integer between 1 and 10.";
  return undefined;
}
