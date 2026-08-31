# MCP Login Token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/mcp-login` route to the SPA that mints a one-time-shown, opaque bearer token per signed-in user, storing only its hash (mapped to the user's Supabase refresh token) in the existing `mcp_sessions` table.

**Architecture:** The app already gates every route behind Supabase magic-link auth (`src/App.tsx`'s `Gate` component renders `<Login/>` for the whole app when there's no session), so `/mcp-login` satisfies "lets a user sign in via Supabase magic link" for free — it only needs to render once a session exists. A new Vercel serverless function (`api/mcp-login.ts`, Node.js runtime) verifies the caller's Supabase access token, mints a random opaque token, stores `sha256(token)` (never the raw value) plus the caller's refresh token in `mcp_sessions` using the service-role key, and returns the raw token once. A new screen (`src/screens/MCPLogin.tsx`) calls that endpoint from a button and displays the returned token; clicking the button again mints and displays a new one, satisfying "request a new token at any time."

**Tech Stack:** React + TypeScript + Vite (frontend), Vercel Node.js serverless function + `@supabase/supabase-js` (backend), Vitest + Testing Library (tests).

**Spec:** `bd show exercise-k67.3` (acceptance criteria below); schema from `bd show exercise-k67.4` / `supabase/migrations/0004_mcp_sessions.sql`.

## Global Constraints

- Acceptance criteria (from `exercise-k67.3`):
  1. New route in the existing SPA (e.g. `/mcp-login`) lets a user sign in via Supabase magic link.
  2. On successful login, the page mints an opaque bearer token for that user and stores it (via the session store table) mapped to their Supabase refresh token.
  3. The bearer token is shown to the user once, to paste into their MCP client config — never logged or stored anywhere in plaintext.
  4. A user can request a new token at any time.
- `mcp_sessions` schema is fixed (already migrated, closed bead `exercise-k67.4`): `id uuid`, `user_id uuid`, `token text` (unique index), `refresh_token text`, `created_at timestamptz`. RLS is enabled with **no** policies — only a service-role client can read/write it. Do not add policies or alter this table.
- "Never stored anywhere in plaintext" governs the `token` column: store `sha256Hex(rawToken)`, not `rawToken`. Never `console.log`/throw errors that include the raw token or the refresh token.
- No `@vercel/node` or edge-runtime dependency — write the handler against a minimal local `(req, res)`-shaped interface compatible with Vercel's Node.js runtime, and add `@types/node` so `process.env` typechecks.
- **Deployment note (not part of these tasks, do before this ships live):** the Vercel project needs two new environment variables — `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (service-role key, never `VITE_`-prefixed so it's never bundled client-side). These are separate from the existing `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` client vars.

---

## File Structure

- `api/mcp-login.ts` (create) — Vercel Node.js serverless function. Exports `generateOpaqueToken`, `sha256Hex`, `mintMcpToken` (pure-ish, dependency-injected core logic) and a default `handler` that wires env vars + `@supabase/supabase-js` into `mintMcpToken`.
- `api/mcp-login.test.ts` (create) — unit tests for all of the above.
- `src/screens/MCPLogin.tsx` (create) — screen with a "Generate token" button that calls `POST /api/mcp-login` and displays the result.
- `src/screens/MCPLogin.test.tsx` (create) — component tests, mocking `../data/supabaseClient` and `fetch`.
- `src/App.tsx` (modify) — add the `/mcp-login` route and a nav link.
- `tsconfig.json` (modify) — include `api/` in typecheck scope; add `"node"` to `types` so `process.env` resolves.
- `package.json` (modify) — add `@types/node` devDependency.

---

### Task 1: `api/mcp-login.ts` — mint-and-store endpoint

**Files:**
- Create: `api/mcp-login.ts`
- Test: `api/mcp-login.test.ts`
- Modify: `tsconfig.json`
- Modify: `package.json`

**Interfaces:**
- Produces (consumed by Task 2's `MCPLogin.tsx` via `fetch`): `POST /api/mcp-login` with JSON body `{ access_token: string, refresh_token: string }` → `200 { token: string }` on success, or `400/401/500 { error: string }`.
- Produces (consumed by the future, already-blocked bead `exercise-k67.6`): the `mcp_sessions.token` column holds `sha256Hex(rawToken)` — any future lookup of a presented bearer token must hash it the same way (`createHash("sha256").update(token).digest("hex")`) before querying.

- [ ] **Step 1: Add `@types/node` and widen `tsconfig.json`**

Edit `package.json` devDependencies (alphabetical, matching existing style) to add:
```json
    "@types/node": "^24.13.1",
```

Edit `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["vitest/globals", "node"]
  },
  "include": ["src", "api"]
}
```

Run: `npm install`
Expected: lockfile updates, `@types/node` appears under `node_modules/@types/node`.

- [ ] **Step 2: Write the failing tests**

Create `api/mcp-login.test.ts`:

```ts
// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";

const getUser = vi.fn();
const insert = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { getUser }, from: () => ({ insert }) })),
}));

import { createClient } from "@supabase/supabase-js";
import handler, { generateOpaqueToken, mintMcpToken, sha256Hex } from "./mcp-login";

afterEach(() => {
  vi.unstubAllEnvs();
  getUser.mockReset();
  insert.mockReset();
  vi.mocked(createClient).mockClear();
});

test("generateOpaqueToken returns unique, url-safe tokens", () => {
  const a = generateOpaqueToken();
  const b = generateOpaqueToken();
  expect(a).not.toBe(b);
  expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("sha256Hex is deterministic and input-sensitive", () => {
  expect(sha256Hex("hello")).toBe(sha256Hex("hello"));
  expect(sha256Hex("hello")).not.toBe(sha256Hex("world"));
});

test("mintMcpToken stores a hash of the token, not the raw value", async () => {
  const inserted: Record<string, unknown>[] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        inserted.push(row);
        return { error: null };
      },
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await mintMcpToken({ accessToken: "at", refreshToken: "rt" }, { client } as any);

  expect(result).toEqual({ ok: true, token: expect.any(String) });
  const token = (result as { ok: true; token: string }).token;
  expect(inserted).toEqual([{ user_id: "user-1", token: sha256Hex(token), refresh_token: "rt" }]);
});

test("rejects an invalid session without writing a row", async () => {
  const insertFn = vi.fn();
  const client = {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: "bad" } }) },
    from: () => ({ insert: insertFn }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await mintMcpToken({ accessToken: "bad", refreshToken: "rt" }, { client } as any);

  expect(result).toEqual({ ok: false, status: 401, error: "Invalid session" });
  expect(insertFn).not.toHaveBeenCalled();
});

test("rejects missing fields without calling supabase", async () => {
  const getUserFn = vi.fn();
  const client = { auth: { getUser: getUserFn }, from: () => ({ insert: vi.fn() }) };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await mintMcpToken({ accessToken: "", refreshToken: "rt" }, { client } as any);

  expect(result).toEqual({ ok: false, status: 400, error: "access_token and refresh_token are required" });
  expect(getUserFn).not.toHaveBeenCalled();
});

test("surfaces a 500 when the insert fails", async () => {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: () => ({ insert: async () => ({ error: { message: "db down" } }) }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await mintMcpToken({ accessToken: "at", refreshToken: "rt" }, { client } as any);

  expect(result).toEqual({ ok: false, status: 500, error: "Could not create token" });
});

test("handler returns 405 for non-POST requests", async () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await handler({ method: "GET" }, { status } as any);

  expect(status).toHaveBeenCalledWith(405);
  expect(json).toHaveBeenCalledWith({ error: "Method not allowed" });
});

test("handler mints a token end-to-end using env-configured clients", async () => {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  insert.mockResolvedValue({ error: null });

  const json = vi.fn();
  const status = vi.fn(() => ({ json }));

  await handler(
    { method: "POST", body: { access_token: "at", refresh_token: "rt" } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { status } as any,
  );

  expect(createClient).toHaveBeenCalledWith("https://example.supabase.co", "service-key");
  expect(status).toHaveBeenCalledWith(200);
  expect(json).toHaveBeenCalledWith({ token: expect.any(String) });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run api/mcp-login.test.ts`
Expected: FAIL — `Failed to resolve import "./mcp-login"` (the module doesn't exist yet).

- [ ] **Step 4: Write the implementation**

Create `api/mcp-login.ts`:

```ts
import { randomBytes, createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

interface VercelLikeRequest {
  method?: string;
  body?: unknown;
}

interface VercelLikeResponse {
  status(code: number): VercelLikeResponse;
  json(body: unknown): void;
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export type MintResult = { ok: true; token: string } | { ok: false; status: number; error: string };

interface MintDeps {
  client: Pick<SupabaseClient, "auth" | "from">;
}

// The `token` column stores sha256Hex(token), never the raw value — the raw
// token is returned to the caller exactly once and is not retrievable again.
export async function mintMcpToken(
  input: { accessToken: string; refreshToken: string },
  deps: MintDeps,
): Promise<MintResult> {
  const { accessToken, refreshToken } = input;
  if (!accessToken || !refreshToken) {
    return { ok: false, status: 400, error: "access_token and refresh_token are required" };
  }

  const { data, error: authError } = await deps.client.auth.getUser(accessToken);
  if (authError || !data.user) {
    return { ok: false, status: 401, error: "Invalid session" };
  }

  const token = generateOpaqueToken();
  const { error: insertError } = await deps.client
    .from("mcp_sessions")
    .insert({ user_id: data.user.id, token: sha256Hex(token), refresh_token: refreshToken });
  if (insertError) {
    return { ok: false, status: 500, error: "Could not create token" };
  }

  return { ok: true, token };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body as { access_token?: unknown; refresh_token?: unknown } | undefined;
  const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body?.refresh_token === "string" ? body.refresh_token : "";

  const client = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const result = await mintMcpToken({ accessToken, refreshToken }, { client });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.status(200).json({ token: result.token });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run api/mcp-login.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors (confirms `api/` is in scope and `process` resolves via `@types/node`).

- [ ] **Step 7: Commit**

```bash
git add api/mcp-login.ts api/mcp-login.test.ts tsconfig.json package.json package-lock.json
git commit -m "feat: add /api/mcp-login token-minting endpoint"
```

---

### Task 2: `/mcp-login` screen and routing

**Files:**
- Create: `src/screens/MCPLogin.tsx`
- Test: `src/screens/MCPLogin.test.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `getSupabase()` from `../data/supabaseClient` (existing, returns a `SupabaseClient`; uses `.auth.getSession()`, same shape already used by `src/auth/AuthContext.tsx`). Consumes `POST /api/mcp-login` from Task 1 (`{ access_token, refresh_token }` → `{ token }` or `{ error }`).
- Produces: default-exported `MCPLogin` component, mounted at route `/mcp-login` in `src/App.tsx`'s `Shell`.

- [ ] **Step 1: Write the failing tests**

Create `src/screens/MCPLogin.test.tsx`:

```tsx
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import MCPLogin from "./MCPLogin";

const getSession = vi.fn();
vi.mock("../data/supabaseClient", () => ({
  getSupabase: () => ({ auth: { getSession } }),
}));

afterEach(() => {
  getSession.mockReset();
  vi.unstubAllGlobals();
});

test("generates and displays a token", async () => {
  getSession.mockResolvedValue({ data: { session: { access_token: "at", refresh_token: "rt" } } });
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: "opaque-token-123" }) });
  vi.stubGlobal("fetch", fetchMock);

  render(<MCPLogin />);
  fireEvent.click(screen.getByRole("button", { name: /generate token/i }));

  await waitFor(() => expect(screen.getByDisplayValue("opaque-token-123")).toBeInTheDocument());
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/mcp-login",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ access_token: "at", refresh_token: "rt" }),
    }),
  );
});

test("shows an error when the request fails", async () => {
  getSession.mockResolvedValue({ data: { session: { access_token: "at", refresh_token: "rt" } } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));

  render(<MCPLogin />);
  fireEvent.click(screen.getByRole("button", { name: /generate token/i }));

  await waitFor(() => expect(screen.getByText(/could not create a token/i)).toBeInTheDocument());
});

test("shows an error when there is no active session", async () => {
  getSession.mockResolvedValue({ data: { session: null } });

  render(<MCPLogin />);
  fireEvent.click(screen.getByRole("button", { name: /generate token/i }));

  await waitFor(() => expect(screen.getByText(/session has expired/i)).toBeInTheDocument());
});

test("allows generating a new token after the first one", async () => {
  getSession.mockResolvedValue({ data: { session: { access_token: "at", refresh_token: "rt" } } });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "first" }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "second" }) });
  vi.stubGlobal("fetch", fetchMock);

  render(<MCPLogin />);
  fireEvent.click(screen.getByRole("button", { name: /generate token/i }));
  await waitFor(() => expect(screen.getByDisplayValue("first")).toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: /generate new token/i }));
  await waitFor(() => expect(screen.getByDisplayValue("second")).toBeInTheDocument());
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/screens/MCPLogin.test.tsx`
Expected: FAIL — `Failed to resolve import "./MCPLogin"`.

- [ ] **Step 3: Write the implementation**

Create `src/screens/MCPLogin.tsx`:

```tsx
import { useState } from "react";
import { getSupabase } from "../data/supabaseClient";

export default function MCPLogin() {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function generateToken() {
    setLoading(true);
    setError(null);
    try {
      const { data } = await getSupabase().auth.getSession();
      const session = data.session;
      if (!session) {
        setError("Your session has expired — please sign in again.");
        return;
      }
      const res = await fetch("/api/mcp-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token }),
      });
      if (!res.ok) {
        setError("Could not create a token. Please try again.");
        return;
      }
      const body = await res.json();
      setToken(body.token);
    } catch {
      setError("Could not create a token. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-bold">MCP token</h1>
      <p className="text-sm text-gray-600">
        Generate a bearer token to paste into your MCP client config. It's shown once — if you lose
        it, generate a new one.
      </p>
      <button
        onClick={generateToken}
        disabled={loading}
        className="w-full rounded-lg bg-black p-3 font-semibold text-white disabled:opacity-50"
      >
        {loading ? "Generating…" : token ? "Generate new token" : "Generate token"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {token && (
        <div className="space-y-1">
          <label className="block text-sm" htmlFor="mcp-token">
            Your token (copy it now — it won't be shown again)
          </label>
          <input
            id="mcp-token"
            readOnly
            value={token}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-lg border p-3 font-mono text-sm"
          />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/screens/MCPLogin.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the route and nav link**

Edit `src/App.tsx` — add the import alongside the other screen imports:
```tsx
import LoggedWorkouts from "./screens/LoggedWorkouts";
import MCPLogin from "./screens/MCPLogin";
```

Add the route inside `<Routes>`, after the `/workouts` route:
```tsx
        <Route path="/workouts" element={<LoggedWorkouts />} />
        <Route path="/mcp-login" element={<MCPLogin />} />
```

Add the nav link, after the "Workouts" link:
```tsx
        <Link to="/workouts" className="p-2">Workouts</Link>
        <Link to="/mcp-login" className="p-2">MCP</Link>
```

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: no type errors; all tests pass, including `src/App.test.tsx` (unaffected) and the new files.

- [ ] **Step 7: Commit**

```bash
git add src/screens/MCPLogin.tsx src/screens/MCPLogin.test.tsx src/App.tsx
git commit -m "feat: add /mcp-login screen for minting MCP bearer tokens"
```

---

## Handoff Notes (not a task — read after both tasks are done)

- Before this is usable in a real deployment, add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the Vercel project's environment variables (see Global Constraints above). Nothing in these two tasks can verify that end-to-end without a live Supabase project + Vercel deploy — local `npm test`/`npm run typecheck` cover the logic in isolation.
- This unblocks `exercise-k67.6` (wire MCP tool handlers to authenticate and call the RPC functions), which must hash a presented bearer token with `sha256Hex` (same algorithm, defined in `api/mcp-login.ts`) before looking it up in `mcp_sessions.token`.
