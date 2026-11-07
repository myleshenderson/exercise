import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { TOOL_DEFINITIONS, type ToolInput, type ToolName } from "./tools.js";

// The `{ content: [...] }` (plus optional isError) shape every tool returns.
export type ToolResult = CallToolResult;

// One backend's implementation of every tool. A mapped type over ToolName, so a
// backend missing a handler, or carrying one for a tool that doesn't exist, fails
// to compile.
export type McpToolHandlers = { [K in ToolName]: (input: ToolInput<K>) => Promise<ToolResult> };

// Registers all 25 tools on `server`, in TOOL_DEFINITIONS order, each dispatching to
// its handler. Tools defined without an input schema are registered without one
// (so the SDK skips argument validation, as before) and their handler gets `{}`.
export function registerTools(server: McpServer, handlers: McpToolHandlers): void {
  for (const { name, title, description, inputSchema } of TOOL_DEFINITIONS) {
    // Each entry's handler is typed against its own input; the loop variable is the
    // union of all of them, so widen to the common call signature here.
    const handler = handlers[name] as (input: unknown) => Promise<ToolResult>;
    // The mapped type already demands every handler; this catches a handlers object
    // that got past it via a cast, at startup rather than on the first tools/call.
    if (typeof handler !== "function") throw new Error(`registerTools: no handler for tool "${name}".`);
    if (inputSchema) {
      const shape: z.ZodRawShape = inputSchema;
      server.registerTool(name, { title, description, inputSchema: shape }, async (args) => handler(args));
    } else {
      server.registerTool(name, { title, description }, async () => handler({}));
    }
  }
}
