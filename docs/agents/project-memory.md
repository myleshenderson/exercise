# Project memory

Durable, non-obvious knowledge for agents working on this repo. This file
replaces the `bd remember` store that was retired with beads on 2026-10-25;
the one entry below is that store, exported verbatim. Add new entries as
sections with a short kebab-case heading.

## mcp-sdk-gotcha-api-mcp-ts-once-an

MCP SDK gotcha (api/mcp.ts): once an McpServer tool has ANY inputSchema (even all-optional fields), the SDK's z.object(shape).safeParse() rejects a tools/call whose wire request omits 'arguments' entirely (MCP spec allows this). Fixed generically via withDefaultToolArguments() in api/mcp.ts, which defaults a missing 'arguments' to {} on the raw JSON-RPC body before it reaches the transport. Any new optional-params tool added to this file is already covered by that normalizer - no need to repeat the fix.
