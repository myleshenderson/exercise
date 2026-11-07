# Exercise as a Starkeep app

This repo is also a [Starkeep](https://github.com/starkeep-org/starkeep-core)
app. Starkeep finds it through `starkeep.manifest.json` at the repo root. The
Vercel deployment (`api/`, `src/`, `vercel.json`) does not change: everything
Starkeep-specific lives in `starkeep/`, `starkeep.manifest.json` and
`tsconfig.starkeep.json`.

What works today: the SPA is served on both surfaces, `POST /mcp` is an MCP
endpoint behind a bearer token, and `/api/local-data/*` is the browser's signing
proxy to the app's tables. The endpoint completes `initialize` and
registers **no tools** yet. Tools, the Starkeep DataLayer and browser sign-in
come in later issues of epic AI-386.

## Files

| File | What it is |
| --- | --- |
| `starkeep.manifest.json` | App id `exercise`, tier `community`, targets `local` + `cloud`, the syncable tables, the `static` compute handler. |
| `starkeep/server.ts` | The Hono app (`app.fetch`) both surfaces run: `POST /mcp`, `GET /starkeep-runtime-config`, `/api/session[/*]`, `/api/local-data/*`. |
| `starkeep/mcp.ts` | `createExerciseMcpServer(deps)` (zero tools) and the stateless JSON transport per request. |
| `starkeep/mcp-auth.ts` | `Authorization: Bearer` check against `STARKEEP_MCP_TOKEN`, compared in constant time. |
| `starkeep/serve.ts` | Local entry (`localRun`): Node server on loopback, Hono for server paths, `dist/` for the rest. |
| `starkeep/handler.ts` | Cloud Lambda entry: `createWebAppHandler` + `honoUpstream`. |
| `starkeep/client-routes.ts` | The SPA's client routes, used as cloud `shellPaths`. |
| `starkeep/build-bundle.ts` | `npm run bundle` / `pnpm bundle`: writes `dist.zip`. |
| `starkeep/validate-manifest.ts` | `npm run starkeep:validate`. |

## Scripts

```bash
npm run starkeep:validate   # validateManifest() from @starkeep/admin-manifest; non-zero exit on error
npm run starkeep:serve -- -p 5199   # local server on 127.0.0.1:5199 (what admin-web runs)
npm run bundle              # dist.zip for a cloud install
npm run typecheck           # includes tsconfig.starkeep.json
npm test                    # includes starkeep/*.test.ts
```

### `localRun`: the exact command

The manifest declares:

```json
"localRun": { "command": "npm", "args": ["run", "starkeep:serve", "--"], "portFlag": "-p" }
```

admin-web picks a free port and appends `-p <port>`, so it runs:

```bash
npm run starkeep:serve -- -p <port>
# → tsx starkeep/serve.ts -p <port>
```

`--port <n>` works too, and so does `PORT=<n>` when no flag is passed. The
server binds `127.0.0.1` only and returns 403 for a `Host` header that is not
loopback, as photos does. If `dist/` is missing or older than `src/`,
`index.html`, `vite.config.ts` or `package.json`, the server runs `vite build`
before it listens. `GET /` serves `dist/index.html`. Any path that is not a
server path and not a file in `dist/` also gets `index.html`, the same
fallback `vercel.json` gives.

### `bundle`: the cloud contract

The cloud installer runs `pnpm bundle` in this directory with:

| Env | Meaning | Default when unset (by hand) |
| --- | --- | --- |
| `STARKEEP_APP_BASE_PATH` | Mount prefix; becomes Vite `base` | `/apps/exercise` |
| `STARKEEP_BUNDLE_OUT` | Absolute path to write the zip | `<repo>/dist.zip` (gitignored) |

The script runs `vite build` into a staging `assets/` dir (never `dist/`). It
passes `base` and `build.assetsDir: "_immutable"` inline, because
`vite.config.ts` is shared with Vercel and stays untouched. It then bundles
`starkeep/handler.ts` with esbuild to `index.mjs`, so the manifest's
`index.handler` resolves to it, and zips the result. The zip holds
`index.mjs`, `assets/index.html` and `assets/_immutable/*`.

Known gap: the SPA uses `BrowserRouter` with no `basename`, so client routes
under `/apps/exercise/...` will not match in the cloud. Fixing that means
editing `src/`, which AI-600 tracks.

## Run it locally in admin-web, step by step

1. Clone `starkeep-core` and `starkeep-apps` as siblings, and put this repo
   anywhere you like (a sibling folder works well):

   ```bash
   mkdir ~/starkeep && cd ~/starkeep
   git clone https://github.com/starkeep-org/starkeep-core
   git clone https://github.com/starkeep-org/starkeep-apps
   git clone https://github.com/myleshenderson/exercise
   ```

2. Install dependencies. Run `pnpm install` in `starkeep-core` and in
   `starkeep-apps`. Run `npm install` in this repo. Installed apps run from
   their source checkout, and admin-web refuses to start an app that has no
   `node_modules`.
3. Pick an MCP token and export it in the shell that will start admin-web.
   Apps that admin-web starts inherit its environment:

   ```bash
   export STARKEEP_MCP_TOKEN="$(openssl rand -hex 32)"
   ```

4. Start admin-web from `starkeep-core` with `pnpm --filter admin-web dev`,
   then open http://localhost:3000.
5. In the **Local** section, on the **Data Server** card, click **Start Data
   Server**. It listens on port 9820.
6. Click **Discover apps** in the header and add the absolute path of this
   repo's **parent** directory (e.g. `~/starkeep`). Admin scans each folder
   inside a registered folder for a `starkeep.manifest.json`.
7. On the **Exercise** card, click **Install**, review the grants (eight
   app-private tables, no shared file types) and click **Approve & Install**.
   This writes the app credential to `~/.starkeep/app-creds/exercise.json`.
8. Click **Start Exercise**, then **Open Exercise ↗**. Check MCP with:

   ```bash
   curl -s -X POST http://127.0.0.1:<port>/mcp \
     -H "authorization: Bearer $STARKEEP_MCP_TOKEN" \
     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
   # → {"result":{"tools":[]},"jsonrpc":"2.0","id":1}
   ```

You can also run the server without admin-web:
`STARKEEP_MCP_TOKEN=dev npm run starkeep:serve -- -p 5199`.

## Environment variables

| Variable | Surface | Set by | Used for |
| --- | --- | --- | --- |
| `STARKEEP_MCP_TOKEN` | both | operator (see below) | Bearer token for `POST /mcp`. Read once at startup. Unset or empty: every `/mcp` request returns **503**, never open access. |
| `PORT` | local | person running by hand | Fallback when no `-p`/`--port` is passed. |
| `STARKEEP_DIR` | local | admin-web's env | Root of Starkeep state (default `~/.starkeep`); credentials live in `app-creds/` under it. |
| `STARKEEP_APP_BASE_PATH` | bundle + cloud | installer / Lambda env | Mount prefix `/apps/exercise`: Vite `base` at bundle time, and the web adapter's `basePath` at runtime. |
| `STARKEEP_BUNDLE_OUT` | bundle | installer | Where `dist.zip` is written. |
| `STARKEEP_APP_CLIENT_MODE` | cloud | Pulumi program (`"cloud"`) | Switches `@starkeep/app-client` to cloud mode (HMAC secret from SSM, calls via the shared API Gateway). |
| `STARKEEP_CLOUD_DATA_BASE` | cloud | Pulumi program | API Gateway base for server-to-server signed calls. |
| `STARKEEP_APP_CREDS_PARAMETER_NAME` | cloud | Pulumi program | SSM parameter holding the app's HMAC secret: `/<stackPrefix>/app-creds/exercise`. |
| `STARKEEP_STACK_PREFIX` | cloud | Pulumi program | Deployment stack prefix. |
| `STARKEEP_API_GATEWAY_URL`, `STARKEEP_USER_POOL_ID`, `STARKEEP_USER_POOL_CLIENT_ID`, `STARKEEP_IDENTITY_POOL_ID` | cloud | installer fills the empty placeholders in the manifest `env` | `GET /starkeep-runtime-config` and the session routes. |

**Server-side data access** (for the DataLayer issue; not built here). Locally,
`loadAppCredentials("exercise")` from `@starkeep/app-client` reads
`~/.starkeep/app-creds/exercise.json` = `{ appId, hmacSecret }` (written at
install, mode 0600). `signedFetch(creds, path, init)` then calls the local data
server, e.g. `GET /app-data/db/<table>?where=…` (authoring guide §6a). In the
cloud, the same calls work through the `STARKEEP_APP_CLIENT_MODE`,
`STARKEEP_CLOUD_DATA_BASE` and `STARKEEP_APP_CREDS_PARAMETER_NAME` variables
the platform injects.

**Setting `STARKEEP_MCP_TOKEN` in the cloud.** The installer only fills empty
`env` placeholders whose key it recognises (the four pool/gateway keys), and
`STARKEEP_MCP_TOKEN` is not one of them. A fresh cloud install therefore
deploys with an empty token, and `/mcp` answers 503 until an operator sets the
value. There are two ways: put the token in the manifest `env` of a local,
uncommitted copy before installing, or set it on the Lambda afterwards
(AI-596 does this by hand). A non-empty value in the manifest `env` is
deployed as-is, so never commit one.

## Browser data proxy: `/api/local-data/*`

The SPA never holds the app's HMAC secret. It reaches the data plane through
a same-origin proxy that signs and forwards, mounted exactly as photos mounts
it (authoring guide §4):

```ts
const proxy = createDataProxyHandler({ appId: "exercise", endUserAuth: sessionAuth() });
app.all("/api/local-data/*", (c) => {
  const path = c.req.path.slice("/api/local-data/".length).split("/").filter(Boolean);
  return proxy(c.req.raw, { params: Promise.resolve({ path }) });
});
```

**URL shape.** The browser calls

```
${import.meta.env.BASE_URL}api/local-data/<data-server path>[?<query>]
```

and the proxy forwards `/<data-server path>[?<query>]` to the data server with
the `X-Starkeep-App-Id` / `X-Starkeep-App-Sig` / `X-Starkeep-App-Ts` headers.
For the app's own tables the data-server path is `app-data/db/<table>`
(authoring guide §6a), so:

| Browser request | Forwarded as |
| --- | --- |
| `GET  ${BASE_URL}api/local-data/app-data/db/programs?where={"archived_at":{"is":null}}&order=created_at.asc` | `GET /app-data/db/programs?where=…&order=…` |
| `POST ${BASE_URL}api/local-data/app-data/db/<table>` (JSON body) | `POST /app-data/db/<table>` |
| other verbs under `${BASE_URL}api/local-data/app-data/db/<table>…` | same verb, same path after the mount |

`BASE_URL` is `/` locally and `/apps/exercise/` in the cloud bundle. Always
prefix it: a bare `/api/local-data` escapes the cloud mount. Every verb is
mounted, which the manifest's `ANY /{proxy+}` route admits. The query string
and a `content-type` header pass through; other request headers do not.

**Auth.** `sessionAuth()` is the platform's cookie-session verifier.

- Cloud (`STARKEEP_APP_CLIENT_MODE=cloud`): a request with no valid session
  returns **`401 {"error":"Not authenticated"}`** before the HMAC credential
  is loaded. `/api/local-data/*` is deliberately not in `publicPaths`, so the
  gateway's session authorizer also sits in front of it.
- Local: open, the `sessionAuth()` default (`allowAnonymousLocal: true`). On
  loopback the browser, the data and the person are on one machine.
- Not installed (no credential): `503` with a pointer to admin-web's install
  flow.

`starkeep/dataProxy.test.ts` covers the cloud 401 (real verifier), a
stubbed session (accepted → forwarded with every verb; rejected → 401), and
the local default.

## Public route: `POST /mcp`

The manifest's `static` handler is `auth: "session"`: the gateway's session
authorizer gates every route except the `publicPaths` (the SPA shell routes,
`/_immutable/*`, `/starkeep-runtime-config`, `/api/session/*`). `POST /mcp` is
declared as its own route with a per-route override:

```json
{ "route": "POST /mcp", "auth": "public" }
```

**Justification:** remote MCP client authenticates with a per-install bearer
token held in env STARKEEP_MCP_TOKEN; the app enforces it on every request.

A remote MCP client cannot carry the platform's session cookie or a Cognito
JWT, so the gateway authorizer cannot gate this route. The app is the
boundary (authoring guide §10):

- Missing or empty `STARKEEP_MCP_TOKEN` at startup: every `/mcp` request returns `503 {"error":"mcp_token_not_configured"}`.
- Missing `Authorization`, a scheme other than `Bearer`, or the wrong token: `401 {"error":"unauthorized"}`. Tokens are compared with `crypto.timingSafeEqual` over the SHA-256 digests of both sides, so the buffers always have equal length.
- `GET` (and any other non-POST method) on `/mcp`: `405`, `Allow: POST`.
- No cookies, no Cognito, no OAuth on this route.

`/mcp` is deliberately **not** in `publicPaths`. Under `auth: "session"` each
`publicPaths` entry becomes an `ANY` route, which would replace the narrower
`POST /mcp` declaration. The installer's anonymous-route report lists
`POST /apps/exercise/mcp` as the one declared anonymous route.

The transport matches `api/mcp.ts`: stateless (`sessionIdGenerator:
undefined`), `enableJsonResponse: true`, one server and transport per request,
never SSE. The class is `WebStandardStreamableHTTPServerTransport`. It is the
web-`Request` version of `StreamableHTTPServerTransport`, which only wraps it
for Node `req`/`res`. Hono hands the app a web `Request`.

## Table mapping (contract for the DataLayer issue)

Every application table from `supabase/migrations/` is declared under
`infraRequirements.appSpecificSyncable.tables`, plus the Starkeep-only
`mcp_tokens`. Locally each one becomes `exercise_syncable_<name>`. Table and
column names are unchanged, except that soft delete's `deleted_at` becomes
`archived_at` (below).

**Dropped:**

- Every `user_id` column. Starkeep data is per install, not per row.
- Table `mcp_sessions`: Supabase MCP OAuth session store. It references
  `auth.users`, and Starkeep uses bearer tokens instead (`mcp_tokens`,
  below).
- Table `seed_claims`: Supabase per-user seeding bookkeeping. It references
  `auth.users`.
- RLS policies, grants, RPC functions, foreign keys, unique and partial
  indexes, and column defaults. The manifest has none of these, so the
  DataLayer must enforce or compute them itself.

**Starkeep-only:**

- Table `mcp_tokens`: MCP bearer tokens, stored per install like every other
  table here (there is no user column). It replaces Supabase's `mcp_sessions`
  and has no Supabase counterpart. `token_hash` holds a hash, never the token
  itself. The per-user token issue builds on it. Like every declared table it
  is reachable through `/api/local-data/app-data/db/mcp_tokens`, so the hash
  is the only protection; nothing here reads it yet.

**Soft delete: app-managed `archived_at`.** Supabase's `deleted_at` on
`programs`, `workout_days` and `exercises` maps to a nullable `archived_at`
`timestamp` that the app owns. The app archives a row by writing
`archived_at` (ISO-8601 UTC) and restores it by writing `null`. Archived rows
stay readable, which the analysis functions need (workout history keeps
deleted days). Reads must filter `archived_at` themselves, e.g.
`where={"archived_at":{"is":null}}` for live rows; nothing filters them for
you.

**Server-managed columns:** `updated_at` and `deleted_at` are reserved by the
Starkeep sync runtime and must not be declared. The app never writes
`deleted_at`: it belongs to the sync runtime, which does not guarantee that
rows it marks stay readable, so it cannot carry soft delete.
No Supabase table has its own `updated_at`.

**Type substitutions** (allowed types are exactly `integer, bigint, real,
text, blob, timestamp, boolean`):

| Postgres | Manifest | Notes |
| --- | --- | --- |
| `uuid` (primary key `id`) | `text`, `primaryKey: true`, `notNull: true` | The server never assigns ids. The app generates them with `crypto.randomUUID()`. Supabase's `default gen_random_uuid()` is gone. |
| `uuid` (foreign key) | `text` | No FK enforcement and no cascades. `on delete cascade` / `set null` become DataLayer logic. |
| `timestamptz` | `timestamp` | ISO-8601 UTC with millisecond precision (`toISOString()`). `default now()` is gone, so the app must set it. |
| `date` (`sessions.performed_on`) | `text` | `YYYY-MM-DD`. `timestamp` would reject a bare date. |
| `numeric` (`session_sets.weight`) | `real` | Double precision. Fine for gym weights. |
| `int` | `integer` | |
| `jsonb` (`target_sets`) | `text` | A JSON string (`JSON.stringify` of the `[{weight, reps}]` array), or null. |
| `text` | `text` | |

**Columns** (`nn` = `notNull: true`; PK = `primaryKey: true`):

| Table | Column | Supabase type | Manifest type |
| --- | --- | --- | --- |
| `programs` | `id` | uuid PK | text PK nn |
| | `name` | text not null | text nn |
| | `created_at` | timestamptz not null default now() | timestamp nn |
| | `archived_at` (Supabase `deleted_at`) | timestamptz | timestamp, nullable, app-managed |
| `exercises` | `id` | uuid PK | text PK nn |
| | `name` | text not null | text nn |
| | `cue` | text not null default '' | text nn |
| | `default_sets` | int not null default 3 | integer nn |
| | `default_rep_low` | int not null default 10 | integer nn |
| | `default_rep_high` | int not null default 12 | integer nn |
| | `created_at` | timestamptz not null default now() | timestamp nn |
| | `archived_at` (Supabase `deleted_at`) | timestamptz | timestamp, nullable, app-managed |
| `workout_days` | `id` | uuid PK | text PK nn |
| | `name` | text not null | text nn |
| | `position` | int not null default 0 | integer nn |
| | `program_id` | uuid → programs, on delete set null | text |
| | `program_position` | int | integer |
| | `created_at` | timestamptz not null default now() | timestamp nn |
| | `archived_at` (Supabase `deleted_at`) | timestamptz | timestamp, nullable, app-managed |
| `workout_day_exercises` | `id` | uuid PK | text PK nn |
| | `workout_day_id` | uuid not null → workout_days, cascade | text nn |
| | `exercise_id` | uuid not null → exercises, cascade | text nn |
| | `position` | int not null default 0 | integer nn |
| | `target_sets` | jsonb | text (JSON) |
| `workout_day_exercise_scheme_history` | `id` | uuid PK | text PK nn |
| | `workout_day_id` | uuid not null → workout_days, cascade | text nn |
| | `exercise_id` | uuid not null → exercises, cascade | text nn |
| | `target_sets` | jsonb | text (JSON) |
| | `recorded_at` | timestamptz not null default now() | timestamp nn |
| `sessions` | `id` | uuid PK | text PK nn |
| | `workout_day_id` | uuid → workout_days, on delete set null | text |
| | `performed_on` | date not null | text nn (`YYYY-MM-DD`) |
| | `created_at` | timestamptz not null default now() | timestamp nn |
| `session_sets` | `id` | uuid PK | text PK nn |
| | `session_id` | uuid not null → sessions, cascade | text nn |
| | `exercise_id` | uuid not null → exercises, cascade | text nn |
| | `set_number` | int not null | integer nn |
| | `weight` | numeric not null | real nn |
| | `reps` | int not null | integer nn |
| `mcp_tokens` (Starkeep-only) | `id` | (none) | text PK nn |
| | `token_hash` | (none) | text nn |
| | `label` | (none) | text |
| | `created_at` | (none) | timestamp nn |
| | `last_used_at` | (none) | timestamp |
| | `expires_at` | (none) | timestamp nn |

Supabase rules the DataLayer has to reproduce by hand: the partial unique
index `workout_days (program_id, program_position) where program_id is not
null and deleted_at is null` (here: `archived_at is null`); the append-only rule on
`workout_day_exercise_scheme_history`, which is insert only; and the RPCs
(`get_day_templates`, `get_workout_history`, `adherence_for_day`, `progression_for_exercise`, `scheme_history_for_day_exercise`, `sets_for_exercise`, `training_gaps` and `weekly_volume`). The manifest
declares no `indexes` yet. Add one per filter the DataLayer actually issues
(authoring guide §6), e.g. `workout_day_exercises(workout_day_id)` and
`session_sets(session_id)`.
