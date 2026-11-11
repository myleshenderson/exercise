# Exercise as a Starkeep app

For what the app is and its other deployments, see the [root README](../README.md).

This repo is also a [Starkeep](https://github.com/starkeep-org/starkeep-core)
app. Starkeep finds it through `starkeep.manifest.json` at the repo root. The
Vercel deployment (`api/`, `src/`, `vercel.json`) does not change: everything
Starkeep-specific lives in `starkeep/`, `starkeep.manifest.json` and
`tsconfig.starkeep.json`.

What works today: the SPA is served on both surfaces, `POST /mcp` is an MCP
endpoint behind per-user bearer tokens that the MCP screen mints and revokes
(`/api/mcp-login`, `/api/mcp-sessions`; see [MCP tokens](#mcp-tokens)), and
`/api/local-data/*` is the browser's signing proxy to the app's tables. The endpoint serves the 25
tools pinned in `src/mcp/__fixtures__/tools-list.main.json`.

## Files

| File | What it is |
| --- | --- |
| `starkeep.manifest.json` | App id `exercise`, tier `community`, targets `local` + `cloud`, the syncable tables, the `static` compute handler. |
| `starkeep/server.ts` | The Hono app (`app.fetch`) both surfaces run: `POST /mcp`, `POST /api/mcp-login`, `/api/mcp-sessions`, `GET /starkeep-runtime-config`, `/api/session[/*]`, `/api/local-data/*`. |
| `starkeep/mcp.ts` | `createExerciseMcpServer(deps)`, serving the 25 tools pinned in `src/mcp/__fixtures__/tools-list.main.json`, and the stateless JSON transport per request. `deps.context` is who the request acts for. |
| `starkeep/mcp-auth.ts` | `POST /mcp` gate: unseals the bearer token, mints and caches the user's ID token (cloud), checks the `mcp_tokens` row, resolves `{ sub, userToken, tokenId }`. |
| `starkeep/mcp-login.ts`, `starkeep/mcp-sessions.ts` | Mint, list and revoke MCP tokens from the browser session; same JSON as `api/mcp-login.ts` / `api/mcp-sessions.ts`. |
| `starkeep/token.ts` | The `exr_` sealed token: AES-256-GCM under an HKDF key from the app's HMAC secret. |
| `starkeep/originGuard.ts` | Local-mode gate on `/api/*`: 403 for a non-loopback `Origin`, 415 for a non-JSON `POST`/`PATCH`/`DELETE`. |
| `starkeep/caller.ts` | Resolves the browser caller: platform session in the cloud, open on loopback. |
| `starkeep/serverTransport.ts` | `createServerTransport({ userToken? })`: server-side `Transport` to the app's tables over `signedFetch`, adding `X-Starkeep-User-Token` when given. |
| `starkeep/mcpTokens.ts` | The `mcp_tokens` row calls (find, list, insert, delete, touch). |
| `starkeep/serve.ts` | Local entry (`localRun`): Node server on loopback, Hono for server paths, `dist/` for the rest. |
| `starkeep/handler.ts` | Cloud Lambda entry: `createWebAppHandler` + `honoUpstream`. |
| `starkeep/client-routes.ts` | The SPA's client routes, used as cloud `shellPaths`. Includes `/sign-in`, where the cloud's CloudFront function sends a signed-out browser; it must stay public and served (see `docs/agents/project-memory.md`). |
| `starkeep/build-bundle.ts` | `npm run bundle` / `pnpm bundle`: writes `dist.zip`. |
| `starkeep/spa-build.ts` | The Starkeep `vite build` both of the above use: forces `VITE_DATA_BACKEND=starkeep`, checks the main chunk, and decides when the local `dist/` needs a rebuild. |
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
loopback, as photos does. Every `/api/*` request carrying an `Origin` header
that is not `http://127.0.0.1`, `http://localhost` or `http://[::1]` on the
server's own port gets 403 `{ "error": "forbidden_origin" }` before any
handler runs (`starkeep/originGuard.ts`); `/mcp`, which has its own bearer
token, is exempt. A `POST`, `PUT`, `PATCH` or `DELETE` under `/api/*` whose
`Content-Type` is not `application/json` gets 415, so the "simple" cross-site
requests a hostile page can send without a CORS preflight never reach the
signing proxy (cloud mode skips both checks).

If `dist/` is missing, older than `src/`, `index.html`, `vite.config.ts` or
`package.json`, or not a Starkeep build, the server runs `vite build` before it
listens. That build sets `VITE_DATA_BACKEND=starkeep` (Vite bakes it in; the
repo has no `.env`, and an unset value means the mock backend) and writes
`dist/.starkeep-backend`. A `dist/` without that marker, such as one from a
plain `npm run build` for Vercel, is rebuilt on the next start even when it is
newer than the sources. Both builds fail if the main chunk bundles supabase-js
or lacks the Starkeep DataLayer (`starkeep/spa-build.ts`). `GET /` serves `dist/index.html`. Any path that is not a
server path and not a file in `dist/` also gets `index.html`, the same
fallback `vercel.json` gives.

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
   no tables: the app's nine app-private tables are not shown there
   (starkeep-core #142 tracks the dialog). Click **Approve & Install**.
   This writes the app credential to `~/.starkeep/app-creds/exercise.json`.
7. Click **Start Exercise**, then **Open Exercise ↗**. Open the MCP screen
   (`/mcp-login`), click to create a token, and check MCP with it:

   ```bash
   TOKEN=exr_...   # from the MCP screen, or: curl -s -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:<port>/api/mcp-login
   curl -s -X POST http://127.0.0.1:<port>/mcp \
     -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
   # → a JSON-RPC result whose "tools" array lists the 25 tools
   ```

You can also run the server without admin-web:
`npm run starkeep:serve -- -p 5199`. It needs the app credential in
`~/.starkeep/app-creds/exercise.json` and a running data server, because tokens
are rows in `mcp_tokens`.

## Environment variables

| Variable | Surface | Set by | Used for |
| --- | --- | --- | --- |
| `PORT` | local | person running by hand | Fallback when no `-p`/`--port` is passed. |
| `STARKEEP_DIR` | local | admin-web's env | Root of Starkeep state (default `~/.starkeep`); credentials live in `app-creds/` under it. |
| `STARKEEP_APP_BASE_PATH` | bundle + cloud | installer / Lambda env | Mount prefix `/apps/exercise`: Vite `base` at bundle time, and the web adapter's `basePath` at runtime. |
| `STARKEEP_BUNDLE_OUT` | bundle | installer | Where `dist.zip` is written. |
| `VITE_DATA_BACKEND` | local + bundle | `starkeep/spa-build.ts` | Always `starkeep` in both Starkeep builds, whatever the shell says; nothing to set. |
| `STARKEEP_APP_CLIENT_MODE` | cloud | Pulumi program (`"cloud"`) | Switches `@starkeep/app-client` to cloud mode (HMAC secret from SSM, calls via the shared API Gateway). |
| `STARKEEP_CLOUD_DATA_BASE` | cloud | Pulumi program | API Gateway base for server-to-server signed calls. |
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

## Public route: `POST /mcp`

The manifest's `static` handler is `auth: "session"`: the gateway's session
authorizer gates every route except the `publicPaths` (the SPA shell routes,
`/_immutable/*`, `/starkeep-runtime-config`, `/api/session/*`). `POST /mcp` is
declared as its own route with a per-route override:

```json
{ "route": "POST /mcp", "auth": "public" }
```

**Justification:** per-user sealed bearer tokens minted from the app's own
session; see [MCP tokens](#mcp-tokens).

A remote MCP client cannot carry the platform's session cookie or a Cognito
JWT, so the gateway authorizer cannot gate this route. The app is the
boundary (authoring guide §10):

- Missing `Authorization`, a scheme other than `Bearer`, a token that does not unseal, or no `mcp_tokens` row for it (revoked, or another user's): `401 {"error":"unauthorized"}`.
- Cognito refuses the sealed refresh token, or the row's `expires_at` has passed: `401 {"error":"token_expired"}`. The user mints a new token on the MCP screen.
- Cognito failing rather than refusing (5xx, throttling, network): `503 {"error":"auth_unavailable"}`, so the client retries. App not installed or credential load failing: `503`. Data plane error on the row read: `502`, never a pass.
- `GET` (and any other non-POST method) on `/mcp`: `405`, `Allow: POST`.
- No cookies and no OAuth on this route. The only Cognito call is the
  server's own refresh-token exchange (see [MCP tokens](#mcp-tokens)).

`/mcp` is deliberately **not** in `publicPaths`. Under `auth: "session"` each
`publicPaths` entry becomes an `ANY` route, which would replace the narrower
`POST /mcp` declaration. The installer's anonymous-route report lists
`POST /apps/exercise/mcp` as the one declared anonymous route.

The transport matches `api/mcp.ts`: stateless (`sessionIdGenerator:
undefined`), `enableJsonResponse: true`, one server and transport per request,
never SSE. The class is `WebStandardStreamableHTTPServerTransport`. It is the
web-`Request` version of `StreamableHTTPServerTransport`, which only wraps it
for Node `req`/`res`. Hono hands the app a web `Request`.

## MCP tokens

A call from Claude to `POST /mcp` has no browser session, so the token it
presents has to carry the user's identity. This reproduces the Supabase
design (`api/mcp-login.ts`, `api/mcp-sessions.ts`, `api/mcp-auth.ts`): one
opaque bearer token per connection, minted and revoked from the MCP screen.

**Format.** `exr_` + base64url of an AES-256-GCM sealed blob (12-byte IV,
ciphertext, 16-byte tag). The key is HKDF-SHA256 of the app's HMAC secret
(`loadAppCredentials("exercise").hmacSecret`, empty salt, info
`"exercise-mcp-token-v1"`, 32 bytes). The plaintext is
`{ "v": 1, "id": <uuid>, "rt": <Cognito refresh token | null>, "sub": <user sub | null> }`.
A tampered, truncated or foreign token fails to unseal and gets 401. A new
HMAC secret (reinstall) invalidates every outstanding token.

**What is stored.** One `mcp_tokens` row per token: `id`, `token_hash` =
hex `sha256(id)`, `label` (null), `created_at`, `last_used_at` (null until first
use, then written at most once a minute), `expires_at`. The token and the
refresh token inside it are returned once by `POST /api/mcp-login` and never
stored. Revoking (`DELETE /api/mcp-sessions { session_id }`) deletes the row,
and the next `/mcp` call with that token finds no row and gets 401. Cognito
`RevokeToken` is not called.

**Endpoints** (same JSON as the Vercel functions, so `src/screens/MCPLogin.tsx`
only changes its base path):

| Route | Success | Errors |
| --- | --- | --- |
| `POST /api/mcp-login` | `{ token, expires_at }` | 401 `Invalid session`, 500 `Could not create token`, 405 |
| `POST` or `GET /api/mcp-sessions` | `{ sessions: [{ id, createdAt, lastUsedAt }] }`, newest first (`lastUsedAt` is `createdAt` until first use) | 401, 500 `Could not list sessions`, 405 |
| `DELETE /api/mcp-sessions` `{ session_id }` | `{ ok: true }` | 400, 404 `Session not found`, 500 `Could not revoke session` |

`POST` and `DELETE` must be `content-type: application/json` (415 otherwise),
so a cross-site form cannot mint or revoke with the user's cookie or against
the loopback server.

**Cloud.** The browser routes need the platform session: the `sk_session`
cookie (the user's Cognito refresh token) and an ID token from `mintIdToken`,
the resolver behind `sessionAuth()`. No session gives 401. `POST
/api/mcp-login` goes further. Before sealing the refresh token, it exchanges
it with Cognito (`refreshTokens`) and verifies the resulting ID token
(`verifyIdToken`), so a dead refresh token gives 401 instead of a token that
is dead on arrival. The token seals that refresh token and the `sub` from the
same exchange; the row is written with the ID
token as `X-Starkeep-User-Token`, so the data plane files it under that user,
and list and revoke only ever see the caller's rows. On `/mcp` the server
exchanges the sealed refresh token for an ID token (`refreshTokens`) and
caches it in module scope, keyed by token id, until 60 s before its `exp`.
That ID token goes on the row read and is handed to the tool handlers as
`deps.context = { sub, userToken, tokenId }`. The minted ID token's `sub`
must equal the sealed `sub`, or the call gets 401. If Cognito refuses the refresh
token (expired, revoked, or the user's sessions were signed out globally),
`/mcp` answers 401 `token_expired`.

**Why 30 days in the cloud.** `expires_at` is creation time + 30 days because
refresh tokens for cloud apps live 30 days (`SESSION_MAX_AGE_S`). A token
cannot outlive the refresh token sealed in it. That refresh token was issued
at sign-in, possibly days before the MCP token was created, so Cognito may
refuse it before `expires_at`. Either way the result is 401 `token_expired`.

**Local mode** (`STARKEEP_APP_CLIENT_MODE` not `cloud`): there is no session
and no user token anywhere. `POST /api/mcp-login` works without signing in,
because the server binds `127.0.0.1`, refuses a non-loopback `Host`, and the
library has one owner. `rt` and `sub` are null, `expires_at` is ten years out,
and the row read on `/mcp` is HMAC-signed only. A token minted locally does
not work against a cloud install (its `rt` is null), and the HMAC secrets
differ anyway.

## Table mapping

Every application table from `supabase/migrations/` is declared under
`infraRequirements.appSpecificSyncable.tables`, plus the Starkeep-only
`mcp_tokens` and `app_meta`. Locally each one becomes `exercise_syncable_<name>`. Table and
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
  itself. See [MCP tokens](#mcp-tokens). Like every declared table it is
  reachable through `/api/local-data/app-data/db/mcp_tokens`; that exposes
  only the user's own rows (ids, hashes, timestamps), from which no token can
  be built without the app's HMAC secret.
- Table `app_meta`: per-install key/value bookkeeping for the DataLayer. It
  replaces Supabase's `seed_claims`. Starkeep's insert is a last-writer-wins
  upsert, so a duplicate key never fails and one shared row cannot pick a
  winner. `src/data/starkeep.ts` `claimSeed()` therefore returns false if any
  `seed_claim:*` row exists; otherwise it writes its own
  `seed_claim:<uuid>` row (value: the ISO time), waits briefly for concurrent
  claims to land, and seeds only if its id sorts first. The key column is
  `id`, not `key`, because every table here keys on a text `id`
  (`starkeep/manifest.test.ts`).

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
| `app_meta` (Starkeep-only) | `id` (the key, e.g. `seed_claim:<uuid>`) | (none) | text PK nn |
| | `value` | (none) | text |

Supabase rules the DataLayer has to reproduce by hand: the partial unique
index `workout_days (program_id, program_position) where program_id is not
null and deleted_at is null` (here: `archived_at is null`); the append-only rule on
`workout_day_exercise_scheme_history`, which is insert only; and the RPCs
(`get_day_templates`, `get_workout_history`, `adherence_for_day`, `progression_for_exercise`, `scheme_history_for_day_exercise`, `sets_for_exercise`, `training_gaps` and `weekly_volume`). The manifest
declares no `indexes` yet. Add one per filter the DataLayer actually issues
(authoring guide §6), e.g. `workout_day_exercises(workout_day_id)` and
`session_sets(session_id)`.
