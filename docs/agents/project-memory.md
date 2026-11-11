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

## garmin-personal-api-openapi-spec-location

The Garmin Connect Personal API OpenAPI 3.0.1 spec is committed at
`docs/reference/garmin-personal-api-openapi.json` (26 GET endpoints, 109
schemas). Garmin publishes no spec URL: the developer site
(https://developer.garmin.com/gc-developer-program/personal/swagger-docs/) is
a Gatsby build that inlines the spec as a `JSON.parse('...')` string inside
the page's `component---src-pages-gc-developer-program-personal-swagger-docs-js-*.js`
bundle, so DevTools shows no spec request. To refresh it, fetch that bundle,
cut the single-quoted JSON literal out, JS-unescape it and parse. Captured
2026-11-11 while running `scripts/probes/garmin-probe.sh` for AI-627.

## Ride sync

The ride sync (`src/sync/runner.ts`, with `scripts/sync.ts` and the `api/sync.ts` daily cron;
runbook in `docs/ride-sync.md`) talks to Garmin, Peloton and Supabase, and the agent container
can reach none of them. Sync code is therefore validated only with an injected `fetch`, the
in-memory store (`src/sync/testing/memoryStore.ts`) and fixtures; no agent has run it live. The
first full backfill is owner-run (Myles, from his machine, `npm run sync -- --source … --full`),
not an agent's job. The cron only keeps current, though the adapters backfill an incomplete
source in either mode, so a cron run before the backfill ends chips at it 50 s a day.
Added 2026-11-11 (AI-641).
