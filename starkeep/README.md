# Exercise as a Starkeep app

For what the app is and its other deployments, see the [root README](../README.md).

This repo is also a [Starkeep](https://github.com/starkeep-org/starkeep-core)
app. Starkeep finds it through `starkeep.manifest.json` at the repo root. The
Vercel deployment (`api/`, `src/`, `vercel.json`) does not change: everything
Starkeep-specific lives in `starkeep/`, `starkeep.manifest.json` and
`tsconfig.starkeep.json`.

What works today: the SPA is served on both surfaces, `POST /mcp` is an MCP
endpoint that outside clients reach with the platform's delegated access
(OAuth sign-in or a pasted token; see
[Delegated route: `POST /mcp`](#delegated-route-post-mcp)), and
`/api/local-data/*` is the browser's signing proxy to the app's tables. The endpoint serves the 32
tools pinned in `src/mcp/__fixtures__/tools-list.main.json`.

## Files

| File | What it is |
| --- | --- |
| `starkeep.manifest.json` | App id `exercise`, tier `community`, targets `local` + `cloud`, the syncable tables, the `static` compute handler. |
| `starkeep/server.ts` | The Hono app (`app.fetch`) both surfaces run: `POST /mcp`, `GET /starkeep-runtime-config`, `/api/session[/*]`, `/api/local-data/*`. |
| `starkeep/mcp.ts` | `createExerciseMcpServer(deps)`, serving the 32 tools pinned in `src/mcp/__fixtures__/tools-list.main.json`, and the stateless JSON transport per request. `deps.principal` is who the request acts for, as `verifyDelegation` returned it. |
| `starkeep/serverTransport.ts` | `createServerTransport({ delegation? })`: server-side `Transport` to the app's tables over `signedFetch`, forwarding the delegation token when given. |
| `starkeep/cloud/` | `npm run test:cloud`: `/mcp` on a throwaway AWS test stack. See [Cloud test](#cloud-test). |
| `starkeep/platform/` | `npm run test:platform`: the DataLayer contract on a real local data server. See [Platform test](#platform-test). |
| `scripts/link-core-harness.mjs` | Links starkeep-core's unpublished test harnesses into `node_modules/@starkeep/` before `test:cloud` and `test:platform`. Copied unchanged from core's example app. |
| `starkeep/serve.ts` | Local entry (`localRun`): the platform's `serveLocal`, with the build in `dist/` and the Hono app. |
| `starkeep/handler.ts` | Cloud Lambda entry: `createWebAppHandler` + `honoUpstream`. |
| `starkeep/client-routes.ts` | The SPA's client routes, and `staticOptions`, the static responder's options both surfaces use; `starkeep/manifest.test.ts` fails if a `<Route path>` in `src/App.tsx` is not covered. Includes `/sign-in`, where the cloud's CloudFront function sends a signed-out browser; it must stay public and served (see `docs/agents/project-memory.md`). |
| `starkeep/build-bundle.ts` | `npm run bundle` / `pnpm bundle`: writes `dist.zip`. |
| `starkeep/spa-build.ts` | The Starkeep `vite build` both of the above use: forces `VITE_DATA_BACKEND=starkeep`, checks the main chunk, and decides when the local `dist/` needs a rebuild. |
| `starkeep/validate-manifest.ts` | `npm run starkeep:validate`. |

## Scripts

```bash
npm run starkeep:validate   # validateManifest() from @starkeep/admin-manifest; non-zero exit on error
npm run starkeep:serve -- --port 5199   # local server on 127.0.0.1:5199 (what admin-web runs)
npm run bundle              # dist.zip for a cloud install
npm run typecheck           # includes tsconfig.starkeep.json
npm test                    # includes starkeep/*.test.ts
npm run test:cloud          # /mcp on a throwaway AWS test stack; needs a starkeep-core checkout
npm run test:platform       # the DataLayer on a real local data server; needs a starkeep-core checkout
```

### `localRun`: the exact command

The manifest declares:

```json
"localRun": { "command": "npm", "args": ["run", "starkeep:serve", "--"], "portFlag": "--port" }
```

admin-web picks a free port and appends `--port <port>`, so it runs:

```bash
npm run starkeep:serve -- --port <port>
# → tsx starkeep/serve.ts --port <port>
```

`PORT=<n>` works when no flag is passed. The server is the platform's
`serveLocal` from `@starkeep/app-client/local`. It binds `127.0.0.1` only, and
before any route runs it answers 403 to a request whose `Host` is not loopback
and to a request a page on another site sent (by `Sec-Fetch-Site`, or by a
foreign `Origin` on a write from a browser that sends no `Sec-Fetch-Site`). A
hostile page therefore cannot reach the signing proxy or the token routes.

If `dist/` is missing, older than `src/`, `index.html`, `vite.config.ts` or
`package.json`, or not a Starkeep build, the server runs `vite build` before it
listens. That build sets `VITE_DATA_BACKEND=starkeep` (Vite bakes it in; the
repo has no `.env`, and an unset value means the mock backend) and writes
`dist/.starkeep-backend`. A `dist/` without that marker, such as one from a
plain `npm run build` for Vercel, is rebuilt on the next start even when it is
newer than the sources. Both builds fail if the main chunk bundles supabase-js
or lacks the Starkeep DataLayer (`starkeep/spa-build.ts`). Both builds put
their content-hashed files under `_immutable/`, and a local `dist/` from before
that layout is rebuilt too.

The server answers the build's files with the static responder the cloud
Lambda runs, over the same paths (`staticOptions` in
`starkeep/client-routes.ts`). `GET /` and every client route serve
`dist/index.html`, files under `/_immutable/` are cached as immutable, and a
missing file under `/_immutable/` gets 404. Every other path goes to the Hono
app, which answers 404 for a path it has no route for.

### `bundle`: the cloud contract

The cloud installer runs `pnpm bundle` in this directory with:

| Env | Meaning | Default when unset (by hand) |
| --- | --- | --- |
| `STARKEEP_APP_BASE_PATH` | Mount prefix; becomes Vite `base` | `/apps/exercise` |
| `STARKEEP_BUNDLE_OUT` | Absolute path to write the zip | `<repo>/dist.zip` (gitignored) |

The script runs `vite build` with `VITE_DATA_BACKEND=starkeep` into a staging
`assets/` dir (never `dist/`). It passes `base` and `build.assetsDir: "_immutable"` inline, because
`vite.config.ts` is shared with Vercel and stays untouched. It then bundles
`starkeep/handler.ts` with esbuild to `index.mjs`, so the manifest's
`index.handler` resolves to it, and zips the result. The zip holds
`index.mjs`, `assets/index.html` and `assets/_immutable/*`.

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
3. Start admin-web from `starkeep-core` with `pnpm --filter admin-web dev`,
   then open http://localhost:3000.
4. In the **Local** section, on the **Data Server** card, click **Start Data
   Server**. It listens on port 9820.
5. Click **Discover apps** in the header and add the absolute path of this
   repo's **parent** directory (e.g. `~/starkeep`). Admin scans each folder
   inside a registered folder for a `starkeep.manifest.json`.
6. On the **Exercise** card, click **Install**. The dialog says "Exercise
   asks for access to these files. No file-type grants requested." and lists
   no tables: the app's sixteen app-private tables are not shown there
   (starkeep-core #142 tracks the dialog). Click **Approve & Install**.
   This writes the app credential to `~/.starkeep/app-creds/exercise.json`.
7. Click **Start Exercise**, then **Open Exercise ↗**. The MCP screen
   (`/mcp-login`) shows the endpoint. Locally it needs no token, so check
   MCP with:

   ```bash
   curl -s -X POST http://127.0.0.1:<port>/mcp \
     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
   # → a JSON-RPC result whose "tools" array lists the 32 tools
   ```

You can also run the server without admin-web:
`npm run starkeep:serve -- --port 5199`. The tools need the app credential in
`~/.starkeep/app-creds/exercise.json` and a running data server.

## Environment variables

| Variable | Surface | Set by | Used for |
| --- | --- | --- | --- |
| `PORT` | local | person running by hand | Fallback when no `--port` is passed. |
| `STARKEEP_DIR` | local | admin-web's env | Root of Starkeep state (default `~/.starkeep`); credentials live in `app-creds/` under it. |
| `STARKEEP_APP_BASE_PATH` | bundle + cloud | installer / Lambda env | Mount prefix `/apps/exercise`: Vite `base` at bundle time, and the web adapter's `basePath` at runtime. |
| `STARKEEP_BUNDLE_OUT` | bundle | installer | Where `dist.zip` is written. |
| `VITE_DATA_BACKEND` | local + bundle | `starkeep/spa-build.ts` | Always `starkeep` in both Starkeep builds, whatever the shell says; nothing to set. |
| `STARKEEP_APP_CLIENT_MODE` | cloud | Pulumi program (`"cloud"`) | Switches `@starkeep/app-client` to cloud mode (HMAC secret from SSM, calls via the shared API Gateway). |
| `STARKEEP_CLOUD_DATA_BASE` | cloud | Pulumi program | API Gateway base for server-to-server signed calls; `GET /starkeep-runtime-config` also builds the consent pages' addresses from it. |
| `STARKEEP_APP_CREDS_PARAMETER_NAME` | cloud | Pulumi program | SSM parameter holding the app's HMAC secret: `/<stackPrefix>/app-creds/exercise`. |
| `STARKEEP_STACK_PREFIX` | cloud | Pulumi program | Deployment stack prefix. |
| `STARKEEP_API_GATEWAY_URL`, `STARKEEP_USER_POOL_ID`, `STARKEEP_USER_POOL_CLIENT_ID`, `STARKEEP_IDENTITY_POOL_ID` | cloud | installer fills the empty placeholders in the manifest `env` | `GET /starkeep-runtime-config` and the session routes. |

**Server-side data access.** Locally,
`loadAppCredentials("exercise")` from `@starkeep/app-client` reads
`~/.starkeep/app-creds/exercise.json` = `{ appId, hmacSecret }` (written at
install, mode 0600). `signedFetch(creds, path, init)` then calls the local data
server, e.g. `GET /app-data/db/<table>?where=…` (authoring guide §6a). In the
cloud, the same calls work through the `STARKEEP_APP_CLIENT_MODE`,
`STARKEEP_CLOUD_DATA_BASE` and `STARKEEP_APP_CREDS_PARAMETER_NAME` variables
the platform injects.

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

## Delegated route: `POST /mcp`

The manifest's `static` handler is `auth: "session"`: the gateway's session
authorizer gates every route except the `publicPaths` (the SPA shell routes,
`/_immutable/*`, `/starkeep-runtime-config`, `/api/session/*`). `POST /mcp` is
declared as its own route with a per-route override:

```json
{ "route": "POST /mcp", "auth": "delegated" }
```

An MCP client acts for the user with a platform delegation token, sent as
`Authorization: Bearer <token>`. The user gets one in either of two ways
(authoring guide §7b):

- **OAuth sign-in.** The user adds the endpoint to the client with no
  header. The client gets the gateway's 401, finds the route's protected
  resource metadata at its well-known location, and sends the user to the
  platform to sign in and approve `read` or `readwrite` access.
- **Pasted token.** The user creates a token on the platform's connect page
  and passes it to the client as the `Authorization` header.

The user lists and revokes both kinds on the platform's connections page.
The MCP screen (`/mcp-login`) shows the endpoint and links to both pages.
The screen reads the pages' addresses from the `connectUrl` and
`connectionsUrl` fields of `GET /starkeep-runtime-config`. Both pages answer
on the gateway's execute-api host, never on the CloudFront address in
`apiGatewayUrl`. The local runtime config names neither page.

**Cloud.** The gateway refuses a request without a valid delegation token
before the app runs. The handler calls `verifyDelegation` again, because it
forwards the token. A refusal is `delegationRefusal`: 401 with
`WWW-Authenticate: Bearer realm="starkeep"`, plus `error="invalid_token"`
when the request carried a bearer token, which tells an MCP client to refresh
or sign in again. Every row call the tools make carries the token
(`createServerTransport({ delegation })`), so the data plane scopes the rows
to the user and applies the delegation's mode and revocation to each call.
Under a `read` delegation, the write tools fail with the data plane's
refusal.

**Local.** `verifyDelegation` admits a loopback caller with no token, after
the platform's local checks: a loopback `Host`, and no request from a page on
another site. A local endpoint therefore grants full app power to any local
process, as the app's own pages have.

`GET` (and any other non-POST method) on `/mcp` answers `405` with
`Allow: POST`.

`/mcp` is deliberately **not** in `publicPaths`. Under `auth: "session"` each
`publicPaths` entry becomes an `ANY` route, which would replace the narrower
`POST /mcp` declaration.

The transport matches `api/mcp.ts`: stateless (`sessionIdGenerator:
undefined`), `enableJsonResponse: true`, one server and transport per request,
never SSE. The class is `WebStandardStreamableHTTPServerTransport`. It is the
web-`Request` version of `StreamableHTTPServerTransport`, which only wraps it
for Node `req`/`res`. Hono hands the app a web `Request`.

## Cloud test

`npm run test:cloud` checks `/mcp` on a real Starkeep cloud, using
starkeep-core's tier-3 harness (`e2e-aws`, "Environment contract" in its
README). The harness is not published, so the script first runs
`scripts/link-core-harness.mjs`, which finds a starkeep-core checkout through
`STARKEEP_CORE_DIR` or beside this repository and links the harness into
`node_modules/@starkeep/`. `npm test` never needs core.

The run is inert unless `STARKEEP_AWS_TESTS=1`. When enabled, the global
setup (`starkeep/cloud/setup.ts`) runs the harness's `prepare` step: it
deploys or updates a throwaway test stack in the AWS account and region the
harness's environment names, installs Exercise, creates a new user, signs that
user in, and creates a `read` and a `readwrite` delegation token on the
platform's `/connect` page. The suite (`starkeep/cloud/mcp.cloud.ts`) then
checks:

- A request without a token gets the gateway's 401, and the route's protected
  resource metadata names the deployment's authorization server.
- The `readwrite` token lists the 32 tools, creates an exercise, and reads it
  back.
- The `read` token reads, and the platform refuses its write.
- A token the deployment did not sign gets 401.

The suite does not drive an OAuth sign-in: that flow is the platform's, and
core's own tier-3 run proves it. After the suite, the `finish` step deletes
the run's user and tears the stack down on a pass, and leaves everything up on
a failure for debugging. The step's output names the teardown command.

## Platform test

`npm run test:platform` runs the Starkeep DataLayer's contract suite
(`src/data/starkeep/dataLayerContract.ts`) on a real local data server.
`npm test` runs the same suite on the in-memory fake row API
(`src/data/starkeep.contract.test.ts`), so a test that passes on the fake but
fails here means the fake has drifted from the data server.

The harness is not published, so the script first runs
`scripts/link-core-harness.mjs`, which finds a starkeep-core checkout through
`STARKEEP_CORE_DIR` or beside this repository and links starkeep-core's
tier-2 harness (`@starkeep/e2e`) into `node_modules/@starkeep/`. `npm test`
never needs core. The global setup
(`starkeep/platform/setup.ts`) boots a local platform from core's source in a
throwaway state directory, never `~/.starkeep`. Each test installs Exercise's
tables under its own app id, so every test starts with empty tables. The
install leaves out the manifest's compute section, which the DataLayer does
not use. Nothing
outside this machine is touched, and CI does not run the suite.

## Table mapping

Every application table from `supabase/migrations/` except the dropped ones below is declared under
`infraRequirements.appSpecificSyncable.tables`, plus the Starkeep-only
`app_meta`: sixteen in all, pinned by
`starkeep/manifest.test.ts`. Locally each one becomes `exercise_syncable_<name>`. Table and
column names are unchanged, except that soft delete's `deleted_at` becomes
`archived_at` (below), and the ride tables that Supabase keys on `user_id`
or a composite key gain a text `id` (see [Ride analytics tables](#ride-analytics-tables)).

**Dropped:**

- Every `user_id` column. Starkeep data is per install, not per row.
- Table `mcp_sessions`: Supabase MCP OAuth session store. It references
  `auth.users`, and on Starkeep the platform holds outside clients' access
  (see [Delegated route: `POST /mcp`](#delegated-route-post-mcp)).
- Table `seed_claims`: Supabase per-user seeding bookkeeping. It references
  `auth.users`.
- Table `sync_lock` and its `acquire_sync_lock` / `renew_sync_lock`
  functions: the Vercel sync's lease row (AI-659). The Starkeep sync is to
  take its lease in `app_meta` instead (AI-822 decision 5, AI-829).
- RLS policies, grants, RPC functions, foreign keys, check constraints,
  unique and partial indexes, column defaults, and the `moddatetime`
  `updated_at` triggers. The manifest has none of these, so the
  DataLayer must enforce or compute them itself.

**Starkeep-only:**

- Table `app_meta`: per-install key/value bookkeeping, kept for the Starkeep
  sync's lease (AI-822 decision 5, AI-829). No code reads or writes it yet.
  Older installs hold `seed_claim:*` rows in it from the seeding this app used
  before starter ids were fixed, and nothing reads those either. The key
  column is `id`, not `key`, because every table here keys on a text `id`
  (`starkeep/manifest.test.ts`).

**Starter rows: fixed ids instead of a seed claim.** Supabase guards
first-use seeding with a `seed_claims` row. On Starkeep the starter
exercises, days and day links get ids derived from their slugs in
`src/data/seed.ts` (UUIDv5 under a namespace of Exercise's own,
`src/data/starkeep/starterIds.ts`), and `seedStarterData` writes each with
`ifAbsent`. Two surfaces that seed one user before they sync therefore write
the same rows, and sync keeps one copy. A reseed leaves alone a starter row the
user edited or deleted. The DataLayer seeds only when the user has no day of
their own and the starter days are not all there yet, so a user seeded before
this change, whose starter rows have random ids, is not seeded again.

**Writes name one row.** The row API refuses a `PATCH` or `DELETE` whose
`where` does not name the whole primary key as plain values. Every table here
keys on `id`, so the DataLayer selects the ids of the rows it means to change
and writes each by `id`. A write to a row that is not there answers 404 with
`skipped: "missing"`, which the row client returns as a result rather than an
error.

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
None of the strength tables has its own `updated_at`. Every ride table does
in Supabase (moved by a `moddatetime` trigger); here the sync runtime's
`updated_at` takes its place and the app never writes it.

**Type substitutions** (allowed types are exactly `integer, bigint, real,
text, blob, timestamp, boolean`):

| Postgres | Manifest | Notes |
| --- | --- | --- |
| `uuid` (primary key `id`) | `text`, `primaryKey: true`, `notNull: true` | The server never assigns ids. The app generates them with `crypto.randomUUID()`, except for starter rows, whose ids are fixed (see "Starter rows" above). Supabase's `default gen_random_uuid()` is gone. |
| `uuid` (foreign key) | `text` | No FK enforcement and no cascades. `on delete cascade` / `set null` become DataLayer logic. |
| `timestamptz` | `timestamp` | ISO-8601 UTC with millisecond precision (`toISOString()`). `default now()` is gone, so the app must set it. |
| `date` (`sessions.performed_on`, `daily_training_load.date`) | `text` | `YYYY-MM-DD`. `timestamp` would reject a bare date. |
| `numeric` (`session_sets.weight`, `athlete_settings.*_tss*`), `double precision` | `real` | Double precision. Fine for gym weights and ride metrics. |
| `int` | `integer` | |
| `boolean` | `boolean` | |
| `jsonb` (`target_sets`, and the ride columns below) | `text` | A JSON string (`JSON.stringify` of the value; for `target_sets` the `[{weight, reps}]` array), or null. |
| `double precision[]` (`activity_streams.values`) | `text` | A JSON array string; a missing second is a JSON `null` element. |
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
| `app_meta` (Starkeep-only) | `id` (the key) | (none) | text PK nn |
| | `value` | (none) | text |

Supabase rules the DataLayer has to reproduce by hand: the partial unique
index `workout_days (program_id, program_position) where program_id is not
null and deleted_at is null` (here: `archived_at is null`); the append-only rule on
`workout_day_exercise_scheme_history`, which is insert only; and the RPCs
(`get_day_templates`, `get_workout_history`, `adherence_for_day`, `progression_for_exercise`, `scheme_history_for_day_exercise`, `sets_for_exercise`, `training_gaps` and `weekly_volume`). Indexes are listed under
[Indexes](#indexes).

### Ride analytics tables

The eight tables of `supabase/migrations/20261111131256_ride_analytics.sql`
(epic AI-822; declared by AI-824). Until AI-825 replaces
`rideAnalyticsStub` in `src/data/starkeep.ts`, the Starkeep DataLayer still
answers ride reads with empty or default results and rejects ride writes;
the tables exist but nothing reads or writes them yet. The substitutions
above apply, plus:

- No `user_id` (as everywhere). `athlete_settings`, `daily_training_load` and
  `sync_state` have no Supabase `id`: their primary key was `user_id` or
  `(user_id, …)`. Every table here gets `id text primaryKey notNull`.
- No `updated_at`: reserved by the sync runtime (above).
- `activity_streams` keeps its column named `values` (quoted in Postgres
  because `VALUES` is reserved; the data server quotes identifiers itself).
- `check (... in (...))` constraints on `source`, `environment`, `channel`,
  `tss_source`, `units`, `week_start`, `auth_status` and `provider`, and
  `ftp_w > 0`, are gone: the DataLayer and the ingesters validate them.
- `paired_activity_id` (`on delete set null`) and `activity_streams.activity_id`
  (`on delete cascade`) are plain text; deleting an activity must clear or
  delete them in the DataLayer.

**Id scheme** (AI-822 decision 1). Ids are deterministic, never random, so a
re-sync of the same provider row is an upsert onto the same id (Starkeep's
insert is last-writer-wins), standing in for Supabase's unique constraints.
Pinned by `starkeep/manifest.test.ts`.

| Table | Id | Replaces Supabase |
| --- | --- | --- |
| `external_activities` | `external_activities.id` = `<source>:<source_id>` | `unique (user_id, source, source_id)` |
| `body_weights` | `body_weights.id` = `<source>:<source_id>` | `unique (user_id, source, source_id)` |
| `activity_streams` | `activity_streams.id` = `<activity_id>:<channel>` | `unique (activity_id, channel)` |
| `ftp_history` | `ftp_history.id` = `<effective_from ISO>\|<source>` | `unique (user_id, effective_from, source)` |
| `daily_training_load` | `daily_training_load.id` = `<date YYYY-MM-DD>` | `primary key (user_id, date)` |
| `sync_state` | `sync_state.id` = `<source>` | `primary key (user_id, source)` |
| `athlete_settings` | `athlete_settings.id` = `"settings"` | `primary key (user_id)`; one row per install |
| `provider_credentials` | `provider_credentials.id` = `<provider>` | `unique (user_id, provider)` |

`<effective_from ISO>` is `toISOString()` (UTC, milliseconds), so the same
instant always spells the same id. `<activity_id>` is the parent's own id, so
a stream id reads e.g. `garmin:123456:power`.

**JSON-in-text columns** (a `JSON.stringify` string; parse on read):

| Column | Holds | Nullable |
| --- | --- | --- |
| `external_activities.power_curve` | power curve (jsonb) | yes |
| `external_activities.best_efforts` | best efforts (jsonb) | yes |
| `external_activities.provider_payload` | the provider's summary object, unmodified | no |
| `activity_streams.values` | 1 Hz samples (`double precision[]`), `null` for a missing second | no |
| `body_weights.provider_payload` | the provider's weigh-in object, unmodified | no |
| `daily_training_load.tss_by_source` | `{ garmin, peloton, strava_export, strength }` TSS | no (`"{}"` when empty) |
| `sync_state.cursor` | the feed's sync cursor | yes |

**`provider_credentials` is readable by the user.** Like every declared table
it is reachable through `/api/local-data/app-data/db/provider_credentials`,
so the signed-in user (or anything on loopback locally) can read its rows.
Supabase's "RLS on, no policies, service role only" protection has no
counterpart here. What makes that acceptable: the rows hold only ciphertext
(`ciphertext`, `iv`, `auth_tag`, base64, AES-256-GCM) under a key derived
from the app's HMAC secret, which lives on the server
(`~/.starkeep/app-creds/exercise.json`, or SSM in the cloud) and which the
browser never has. Without it a row decrypts to nothing.

**Ride columns** (`nn` = `notNull: true`; PK = `primaryKey: true`):

| Table | Column | Supabase type | Manifest type |
| --- | --- | --- | --- |
| `external_activities` | `id` | uuid PK | text PK nn (`<source>:<source_id>`) |
| | `source` | text not null, check garmin/peloton/strava_export | text nn |
| | `source_id` | text not null | text nn |
| | `started_at` | timestamptz not null | timestamp nn |
| | `timezone` | text | text |
| | `sport` | text not null | text nn |
| | `sub_type` | text | text |
| | `environment` | text not null, check indoor/outdoor | text nn |
| | `title` | text | text |
| | `elapsed_s` | double precision | real |
| | `moving_s` | double precision | real |
| | `distance_m` | double precision | real |
| | `elevation_gain_m` | double precision | real |
| | `avg_speed_mps` | double precision | real |
| | `max_speed_mps` | double precision | real |
| | `avg_power_w` | double precision | real |
| | `max_power_w` | double precision | real |
| | `normalized_power_w` | double precision | real |
| | `intensity_factor` | double precision | real |
| | `tss` | double precision | real |
| | `work_kj` | double precision | real |
| | `calories` | double precision | real |
| | `avg_hr_bpm` | double precision | real |
| | `max_hr_bpm` | double precision | real |
| | `avg_cadence_rpm` | double precision | real |
| | `biggest_climb_m` | double precision | real |
| | `tss_source` | text, check power/estimated_flat | text |
| | `ftp_used_w` | integer | integer |
| | `ftp_source` | text | text |
| | `has_power` | boolean not null default false | boolean nn |
| | `has_hr` | boolean not null default false | boolean nn |
| | `power_curve` | jsonb | text (JSON) |
| | `best_efforts` | jsonb | text (JSON) |
| | `paired_activity_id` | uuid → external_activities, on delete set null | text |
| | `provider_payload` | jsonb not null | text nn (JSON) |
| | `synced_at` | timestamptz not null default now() | timestamp nn |
| | `created_at` | timestamptz not null default now() | timestamp nn |
| `activity_streams` | `id` | uuid PK | text PK nn (`<activity_id>:<channel>`) |
| | `activity_id` | uuid not null → external_activities, cascade | text nn |
| | `channel` | text not null, check power/heart_rate/cadence/speed/distance/altitude/lat/lng/temperature/resistance | text nn |
| | `start_offset_s` | integer not null default 0 | integer nn |
| | `values` | double precision[] not null | text nn (JSON array) |
| | `created_at` | timestamptz not null default now() | timestamp nn |
| `body_weights` | `id` | uuid PK | text PK nn (`<source>:<source_id>`) |
| | `source` | text not null, check garmin | text nn |
| | `source_id` | text not null (Garmin samplePk) | text nn |
| | `measured_at` | timestamptz not null | timestamp nn |
| | `weight_kg` | double precision not null | real nn |
| | `bmi` | double precision | real |
| | `body_fat_pct` | double precision | real |
| | `body_water_pct` | double precision | real |
| | `muscle_mass_kg` | double precision | real |
| | `bone_mass_kg` | double precision | real |
| | `provider_payload` | jsonb not null | text nn (JSON) |
| | `created_at` | timestamptz not null default now() | timestamp nn |
| `athlete_settings` | `id` | (none; Supabase keys on `user_id`) | text PK nn (`"settings"`) |
| | `manual_ftp_w` | integer | integer |
| | `lthr_bpm` | integer | integer |
| | `max_hr_bpm` | integer | integer |
| | `resting_hr_bpm` | integer | integer |
| | `strength_session_tss` | numeric not null default 50 | real nn |
| | `no_power_tss_per_hour` | numeric not null default 55 | real nn |
| | `units` | text not null default 'imperial', check imperial/metric | text nn |
| | `week_start` | text not null default 'monday', check monday/sunday | text nn |
| | `created_at` | timestamptz not null default now() | timestamp nn |
| `ftp_history` | `id` | uuid PK | text PK nn (`<effective_from ISO>\|<source>`) |
| | `effective_from` | timestamptz not null | timestamp nn |
| | `ftp_w` | integer not null, check > 0 | integer nn |
| | `source` | text not null, check manual/peloton_test/peloton_manual/estimated | text nn |
| | `source_ref` | text | text |
| | `created_at` | timestamptz not null default now() | timestamp nn |
| `daily_training_load` | `id` | (none; Supabase keys on `(user_id, date)`) | text PK nn (`<date YYYY-MM-DD>`) |
| | `date` | date not null | text nn (`YYYY-MM-DD`) |
| | `tss_total` | double precision not null default 0 | real nn |
| | `tss_by_source` | jsonb not null default '{}' | text nn (JSON) |
| | `ctl` | double precision not null | real nn |
| | `atl` | double precision not null | real nn |
| | `tsb` | double precision not null | real nn |
| | `created_at` | timestamptz not null default now() | timestamp nn |
| `sync_state` | `id` | (none; Supabase keys on `(user_id, source)`) | text PK nn (`<source>`) |
| | `source` | text not null, check garmin_activities/garmin_weight/peloton | text nn |
| | `cursor` | jsonb | text (JSON) |
| | `last_run_at` | timestamptz | timestamp |
| | `last_success_at` | timestamptz | timestamp |
| | `items_fetched` | integer not null default 0 | integer nn |
| | `items_upserted` | integer not null default 0 | integer nn |
| | `last_error` | text | text |
| | `backfill_complete` | boolean not null default false | boolean nn |
| | `auth_status` | text not null default 'ok', check ok/reconnect_required | text nn |
| | `created_at` | timestamptz not null default now() | timestamp nn |
| `provider_credentials` | `id` | uuid PK | text PK nn (`<provider>`) |
| | `provider` | text not null, check peloton | text nn |
| | `ciphertext` | text not null (base64) | text nn |
| | `iv` | text not null (base64) | text nn |
| | `auth_tag` | text not null (base64) | text nn |
| | `key_id` | text not null | text nn |
| | `access_expires_at` | timestamptz | timestamp |
| | `rotated_at` | timestamptz | timestamp |
| | `revoked_at` | timestamptz | timestamp |
| | `created_at` | timestamptz not null default now() | timestamp nn |

### Indexes

Declared per table under `indexes` (authoring guide §6), one per filter or
sort the DataLayer issues (for the ride tables, the filters AI-825 is
specified to issue; add one when it issues another). Supabase's
`(user_id, …)` indexes lose their `user_id` prefix, and the manifest has no
sort direction: `external_activities (user_id, started_at desc)` becomes
`(started_at)`, which SQLite scans backwards for a newest-first read.

| Table | Columns | For |
| --- | --- | --- |
| `external_activities` | `(started_at)` | the feed and date-range reads, newest first |
| `external_activities` | `(source, started_at)` | per-provider reads |
| `external_activities` | `(environment, started_at)` | indoor/outdoor filters |
| `activity_streams` | `(activity_id)` | an activity's streams |
| `body_weights` | `(measured_at)` | the weight chart |
| `ftp_history` | `(effective_from)` | the FTP in effect at a date |
| `daily_training_load` | `(date)` | the CTL/ATL/TSB series |
| `workout_days` | `(program_id)` | a program's days (AI-609) |
| `workout_day_exercises` | `(workout_day_id)` | a day's exercises (AI-609) |
| `workout_day_exercise_scheme_history` | `(workout_day_id, exercise_id)` | scheme history for a day's exercise (AI-609) |
| `sessions` | `(performed_on)` | history by date (AI-609) |
| `sessions` | `(workout_day_id)` | a day's sessions (AI-609) |
| `session_sets` | `(session_id)` | a session's sets (AI-609) |
| `session_sets` | `(exercise_id)` | an exercise's sets across sessions (AI-609) |
