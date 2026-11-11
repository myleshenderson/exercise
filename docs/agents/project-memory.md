# Project memory

Durable, non-obvious knowledge for agents working on this repo. This file
replaces the `bd remember` store that was retired with beads on 2026-10-25;
the one entry below is that store, exported verbatim. Add new entries as
sections with a short kebab-case heading.

## mcp-sdk-gotcha-api-mcp-ts-once-an

MCP SDK gotcha (api/mcp.ts): once an McpServer tool has ANY inputSchema (even all-optional fields), the SDK's z.object(shape).safeParse() rejects a tools/call whose wire request omits 'arguments' entirely (MCP spec allows this). Fixed generically via withDefaultToolArguments() in api/mcp.ts, which defaults a missing 'arguments' to {} on the raw JSON-RPC body before it reaches the transport. Any new optional-params tool added to this file is already covered by that normalizer - no need to repeat the fix.

## cloud-apps-must-declare-sign-in

Every Starkeep cloud app must declare `/sign-in` as a public, served client
route. The deployment's CloudFront function (starkeep-core
`cloud-data-server-program.ts`) answers any document navigation under
`/apps/<id>/` that has no `sk_token` cookie with a 302 to
`/apps/<id>/sign-in`, exempting only `/starkeep-runtime-config`, `/p/*` and
the sign-in path itself. If the app has not declared that path in the
manifest's `publicPaths` and `staticAssetPaths` and in
`starkeep/client-routes.ts`, API Gateway's session authorizer refuses it with
`{"message":"Unauthorized"}` before the SPA loads, so nobody ever sees the
sign-in button. The manifest validator does not catch this (it only errors on
empty `publicPaths`). Found on the first cloud install, 2026-11-10 (AI-626);
`starkeep/manifest.test.ts` now pins the declaration, and `src/App.tsx` sends
`/sign-in` to `/` once a session exists. Reproduce the symptom with
`curl -sI -H 'sec-fetch-dest: document' https://<base>/apps/exercise`.
