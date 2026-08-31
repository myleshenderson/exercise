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
