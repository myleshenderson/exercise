// The MCP spec makes a tools/call request's `arguments` field optional, so a
// spec-compliant client calling a tool whose schema is all-optional fields (e.g.
// get_workout_history's filters) may omit it entirely rather than sending `{}`.
// The SDK's zod-based validation requires an actual object once a tool has any
// inputSchema, though, and rejects `undefined` even when every field is optional -
// so default it here before it reaches that validation. Handles both a single
// JSON-RPC message and a batched array of them. Shared by api/mcp.ts (Vercel)
// and starkeep/mcp.ts (Starkeep).
export function withDefaultToolArguments(body: unknown): unknown {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (message && typeof message === "object" && (message as Record<string, unknown>).method === "tools/call") {
      const params = (message as Record<string, unknown>).params;
      if (params && typeof params === "object" && (params as Record<string, unknown>).arguments === undefined) {
        (params as Record<string, unknown>).arguments = {};
      }
    }
  }
  return body;
}
