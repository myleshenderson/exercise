// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";

const getUser = vi.fn();
const selectChain = { order: vi.fn() };
const from = vi.fn(() => ({ select: () => ({ eq: () => selectChain }) }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { getUser }, from })),
}));

import { createClient } from "@supabase/supabase-js";
import handler, { listMcpSessions, revokeMcpSession } from "./mcp-sessions.js";

afterEach(() => {
  vi.unstubAllEnvs();
  getUser.mockReset();
  selectChain.order.mockReset();
  from.mockClear();
  vi.mocked(createClient).mockClear();
});

test("lists only the caller's own sessions, newest first", async () => {
  const eq = vi.fn(() => ({
    order: async () => ({
      data: [
        { id: "row-2", created_at: "2026-09-02T00:00:00.000Z", last_used_at: "2026-09-03T00:00:00.000Z" },
        { id: "row-1", created_at: "2026-09-01T00:00:00.000Z", last_used_at: "2026-09-01T00:00:00.000Z" },
      ],
      error: null,
    }),
  }));
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: () => ({ select: () => ({ eq }) }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await listMcpSessions({ accessToken: "at" }, { client } as any);

  expect(result).toEqual({
    ok: true,
    sessions: [
      { id: "row-2", createdAt: "2026-09-02T00:00:00.000Z", lastUsedAt: "2026-09-03T00:00:00.000Z" },
      { id: "row-1", createdAt: "2026-09-01T00:00:00.000Z", lastUsedAt: "2026-09-01T00:00:00.000Z" },
    ],
  });
  expect(eq).toHaveBeenCalledWith("user_id", "user-1");
});

test("rejects an invalid session without querying mcp_sessions", async () => {
  const fromFn = vi.fn();
  const client = {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: "bad" } }) },
    from: fromFn,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await listMcpSessions({ accessToken: "bad" }, { client } as any);

  expect(result).toEqual({ ok: false, status: 401, error: "Invalid session" });
  expect(fromFn).not.toHaveBeenCalled();
});

test("rejects a missing access_token without calling supabase", async () => {
  const getUserFn = vi.fn();
  const client = { auth: { getUser: getUserFn }, from: vi.fn() };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await listMcpSessions({ accessToken: "" }, { client } as any);

  expect(result).toEqual({ ok: false, status: 400, error: "access_token is required" });
  expect(getUserFn).not.toHaveBeenCalled();
});

test("surfaces a 500 when the select fails", async () => {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: null, error: { message: "db down" } }) }) }) }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await listMcpSessions({ accessToken: "at" }, { client } as any);

  expect(result).toEqual({ ok: false, status: 500, error: "Could not list sessions" });
});

test("handler returns 405 for unsupported methods", async () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await handler({ method: "PATCH" }, { status } as any);

  expect(status).toHaveBeenCalledWith(405);
  expect(json).toHaveBeenCalledWith({ error: "Method not allowed" });
});

test("revokes a session scoped to the caller, and only the caller", async () => {
  const eq2 = vi.fn(async () => ({ error: null, count: 1 }));
  const eq1 = vi.fn(() => ({ eq: eq2 }));
  const deleteFn = vi.fn(() => ({ eq: eq1 }));
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: () => ({ delete: deleteFn }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await revokeMcpSession({ accessToken: "at", sessionId: "row-1" }, { client } as any);

  expect(result).toEqual({ ok: true });
  expect(eq1).toHaveBeenCalledWith("id", "row-1");
  expect(eq2).toHaveBeenCalledWith("user_id", "user-1");
});

test("reports not-found when revoking a session id that doesn't exist or isn't owned by the caller", async () => {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: () => ({ delete: () => ({ eq: () => ({ eq: async () => ({ error: null, count: 0 }) }) }) }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await revokeMcpSession({ accessToken: "at", sessionId: "not-mine" }, { client } as any);

  expect(result).toEqual({ ok: false, status: 404, error: "Session not found" });
});

test("rejects revoking without an access_token or session_id", async () => {
  const getUserFn = vi.fn();
  const client = { auth: { getUser: getUserFn }, from: vi.fn() };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await revokeMcpSession({ accessToken: "", sessionId: "" }, { client } as any);

  expect(result).toEqual({ ok: false, status: 400, error: "access_token and session_id are required" });
  expect(getUserFn).not.toHaveBeenCalled();
});

test("surfaces a 500 when the delete fails", async () => {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: () => ({ delete: () => ({ eq: () => ({ eq: async () => ({ error: { message: "db down" }, count: null }) }) }) }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await revokeMcpSession({ accessToken: "at", sessionId: "row-1" }, { client } as any);

  expect(result).toEqual({ ok: false, status: 500, error: "Could not revoke session" });
});

test("handler revokes a session end-to-end for a DELETE using env-configured clients", async () => {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  const deleteFn = vi.fn(() => ({ eq: () => ({ eq: async () => ({ error: null, count: 1 }) }) }));
  from.mockImplementationOnce(() => ({ delete: deleteFn }));

  const json = vi.fn();
  const status = vi.fn(() => ({ json }));

  await handler(
    { method: "DELETE", body: { access_token: "at", session_id: "row-1" } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { status } as any,
  );

  expect(createClient).toHaveBeenCalledWith("https://example.supabase.co", "service-key");
  expect(status).toHaveBeenCalledWith(200);
  expect(json).toHaveBeenCalledWith({ ok: true });
});

test("handler lists sessions end-to-end for a POST using env-configured clients", async () => {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  selectChain.order.mockResolvedValue({ data: [], error: null });

  const json = vi.fn();
  const status = vi.fn(() => ({ json }));

  await handler(
    { method: "POST", body: { access_token: "at" } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { status } as any,
  );

  expect(createClient).toHaveBeenCalledWith("https://example.supabase.co", "service-key");
  expect(status).toHaveBeenCalledWith(200);
  expect(json).toHaveBeenCalledWith({ sessions: [] });
});
