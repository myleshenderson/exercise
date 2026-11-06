// @vitest-environment node
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type McpToolHandlers, type ToolResult } from "./handlers.js";
import { TOOL_DEFINITIONS, type ToolInput, type ToolName } from "./tools.js";
import mainToolsListJson from "./__fixtures__/tools-list.main.json?raw";

const EXPECTED_TOOL_NAMES = [
  "progression_for_exercise",
  "sets_for_exercise",
  "weekly_volume",
  "training_gaps",
  "get_day_templates",
  "get_workout_history",
  "scheme_history_for_day_exercise",
  "adherence_for_day",
  "create_day_template",
  "rename_day_template",
  "delete_day_template",
  "create_exercise",
  "update_exercise",
  "list_exercises",
  "delete_exercise",
  "add_exercise_to_day",
  "remove_exercise_from_day",
  "reorder_day_exercises",
  "set_day_exercise_scheme",
  "create_program",
  "rename_program",
  "delete_program",
  "add_day_to_program",
  "remove_day_from_program",
  "reorder_program_days",
] as const;

// tools/list exactly as api/mcp.ts on main (96f3b39) returned it, captured once
// before the AI-589 extraction. Any drift in a name, title, description, schema
// or order fails the comparison below.
const MAIN_TOOLS_LIST: unknown = JSON.parse(mainToolsListJson);

// A handler per tool that echoes its tool name and the parsed input back as text.
function stubHandlers(): McpToolHandlers {
  const entries = TOOL_DEFINITIONS.map(({ name }) => [
    name,
    vi.fn(async (input: unknown): Promise<ToolResult> => ({
      content: [{ type: "text", text: JSON.stringify({ name, input }) }],
    })),
  ]);
  return Object.fromEntries(entries) as McpToolHandlers;
}

async function connect(handlers: McpToolHandlers): Promise<Client> {
  const server = new McpServer({ name: "exercise-mcp", version: "0.1.0" });
  registerTools(server, handlers);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

describe("registerTools", () => {
  it("registers exactly the 25 tools, in the order main registers them", async () => {
    const server = new McpServer({ name: "exercise-mcp", version: "0.1.0" });
    const registerTool = vi.spyOn(server, "registerTool");
    registerTools(server, stubHandlers());
    expect(registerTool.mock.calls.map((call) => (call as unknown[])[0])).toEqual(EXPECTED_TOOL_NAMES);
  });

  it("throws at registration when a handler is missing at runtime", () => {
    const { weekly_volume: _omitted, ...rest } = stubHandlers();
    void _omitted;
    const server = new McpServer({ name: "exercise-mcp", version: "0.1.0" });
    expect(() => registerTools(server, rest as McpToolHandlers)).toThrow('registerTools: no handler for tool "weekly_volume".');
  });

  it("tools/list over an in-memory client/server pair matches main's output", async () => {
    const client = await connect(stubHandlers());
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name)).toEqual(EXPECTED_TOOL_NAMES);
    expect(result).toEqual(MAIN_TOOLS_LIST);
    await client.close();
  });

  it("dispatches each call to its own handler with the parsed arguments", async () => {
    const handlers = stubHandlers();
    const client = await connect(handlers);

    const result = await client.callTool({
      name: "set_day_exercise_scheme",
      arguments: { day_id: "d", exercise_id: "e", sets: [{ weight: 50, reps: 8 }] },
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            name: "set_day_exercise_scheme",
            input: { day_id: "d", exercise_id: "e", sets: [{ weight: 50, reps: 8 }] },
          }),
        },
      ],
    });
    expect(handlers.set_day_exercise_scheme).toHaveBeenCalledTimes(1);
    expect(handlers.reorder_day_exercises).not.toHaveBeenCalled();
    await client.close();
  });

  it("calls a schema-less tool's handler with {} and skips argument validation", async () => {
    const handlers = stubHandlers();
    const client = await connect(handlers);
    await client.callTool({ name: "weekly_volume", arguments: { ignored: 1 } });
    expect(handlers.weekly_volume).toHaveBeenCalledWith({});
    await client.close();
  });

  it("rejects arguments that fail the tool's zod schema before reaching the handler", async () => {
    const handlers = stubHandlers();
    const client = await connect(handlers);
    const result = await client.callTool({ name: "create_program", arguments: { name: 42 } });
    expect(result.isError).toBe(true);
    expect(handlers.create_program).not.toHaveBeenCalled();
    await client.close();
  });
});

// Type-level contract: checked by `npm run typecheck` (tsc --noEmit covers src/**,
// test files included), where an unused @ts-expect-error is itself an error.
describe("McpToolHandlers type", () => {
  it("has exactly the ToolName keys, and ToolName is exactly the 25 tool names", () => {
    expectTypeOf<keyof McpToolHandlers>().toEqualTypeOf<ToolName>();
    expectTypeOf<ToolName>().toEqualTypeOf<(typeof EXPECTED_TOOL_NAMES)[number]>();
  });

  it("types each handler's input from its tool's zod schema", () => {
    expectTypeOf<ToolInput<"rename_program">>().toEqualTypeOf<{ program_id: string; name: string }>();
    expectTypeOf<ToolInput<"set_day_exercise_scheme">>().toEqualTypeOf<{
      day_id: string;
      exercise_id: string;
      sets: { weight: number; reps: number }[] | null;
    }>();
    expectTypeOf<ToolInput<"get_workout_history">>().toEqualTypeOf<{
      start_date?: string | undefined;
      end_date?: string | undefined;
      exercise_name?: string | undefined;
    }>();
    expectTypeOf<ToolInput<"weekly_volume">>().toEqualTypeOf<Record<string, never>>();
  });

  it("rejects a handler object with a missing or an extra handler", () => {
    const complete = stubHandlers();
    const { weekly_volume: _omitted, ...missingOne } = complete;
    void _omitted;

    // @ts-expect-error weekly_volume is missing
    const missing: McpToolHandlers = missingOne;
    // @ts-expect-error not_a_tool is not a ToolName
    const extra: McpToolHandlers = { ...complete, not_a_tool: complete.weekly_volume };
    expect(missing).toBeDefined();
    expect(extra).toBeDefined();
  });
});
