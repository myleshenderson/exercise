// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";

const getUser = vi.fn();
const generateLink = vi.fn();
const verifyOtp = vi.fn();
const insert = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser, admin: { generateLink }, verifyOtp },
    from: () => ({ insert }),
  })),
}));

import { createClient } from "@supabase/supabase-js";
import handler, { generateOpaqueToken, mintMcpToken, sha256Hex } from "./mcp-login.js";

function okLink() {
  return { data: { properties: { hashed_token: "hashed-otp" } }, error: null };
}

function okVerify(refreshToken = "minted-refresh") {
  return { data: { session: { access_token: "minted-access", refresh_token: refreshToken } }, error: null };
}

afterEach(() => {
  vi.unstubAllEnvs();
  getUser.mockReset();
  generateLink.mockReset();
  verifyOtp.mockReset();
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

test("mints an independent session for the caller and stores its refresh_token, not one supplied by the caller", async () => {
  const inserted: Record<string, unknown>[] = [];
  const generateLinkFn = vi.fn(async () => okLink());
  const verifyOtpFn = vi.fn(async () => okVerify("minted-refresh"));
  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1", email: "user@example.com" } }, error: null }),
      admin: { generateLink: generateLinkFn },
    },
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        inserted.push(row);
        return { error: null };
      },
    }),
  };
  const authClient = { auth: { verifyOtp: verifyOtpFn } };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await mintMcpToken({ accessToken: "at" }, { client, authClient } as any);

  expect(result).toEqual({ ok: true, token: expect.any(String) });
  const token = (result as { ok: true; token: string }).token;
  expect(inserted).toEqual([{ user_id: "user-1", token: sha256Hex(token), refresh_token: "minted-refresh" }]);
  expect(generateLinkFn).toHaveBeenCalledWith({ type: "magiclink", email: "user@example.com" });
  expect(verifyOtpFn).toHaveBeenCalledWith({ token_hash: "hashed-otp", type: "magiclink" });
});

test("rejects an invalid session without writing a row", async () => {
  const insertFn = vi.fn();
  const client = {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: "bad" } }), admin: { generateLink: vi.fn() } },
    from: () => ({ insert: insertFn }),
  };
  const authClient = { auth: { verifyOtp: vi.fn() } };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await mintMcpToken({ accessToken: "bad" }, { client, authClient } as any);

  expect(result).toEqual({ ok: false, status: 401, error: "Invalid session" });
  expect(insertFn).not.toHaveBeenCalled();
});

test("rejects a user with no email without writing a row", async () => {
  const insertFn = vi.fn();
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "user-1", email: null } }, error: null }), admin: { generateLink: vi.fn() } },
    from: () => ({ insert: insertFn }),
  };
  const authClient = { auth: { verifyOtp: vi.fn() } };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await mintMcpToken({ accessToken: "at" }, { client, authClient } as any);

  expect(result).toEqual({ ok: false, status: 401, error: "Invalid session" });
  expect(insertFn).not.toHaveBeenCalled();
});

test("rejects missing access_token without calling supabase", async () => {
  const getUserFn = vi.fn();
  const client = { auth: { getUser: getUserFn, admin: { generateLink: vi.fn() } }, from: () => ({ insert: vi.fn() }) };
  const authClient = { auth: { verifyOtp: vi.fn() } };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await mintMcpToken({ accessToken: "" }, { client, authClient } as any);

  expect(result).toEqual({ ok: false, status: 400, error: "access_token is required" });
  expect(getUserFn).not.toHaveBeenCalled();
});

test("surfaces a 500 when the admin link generation fails", async () => {
  const insertFn = vi.fn();
  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1", email: "user@example.com" } }, error: null }),
      admin: { generateLink: async () => ({ data: null, error: { message: "nope" } }) },
    },
    from: () => ({ insert: insertFn }),
  };
  const authClient = { auth: { verifyOtp: vi.fn() } };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await mintMcpToken({ accessToken: "at" }, { client, authClient } as any);

  expect(result).toEqual({ ok: false, status: 500, error: "Could not create token" });
  expect(insertFn).not.toHaveBeenCalled();
});

test("surfaces a 500 when redeeming the generated link into a session fails", async () => {
  const insertFn = vi.fn();
  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1", email: "user@example.com" } }, error: null }),
      admin: { generateLink: async () => okLink() },
    },
    from: () => ({ insert: insertFn }),
  };
  const authClient = { auth: { verifyOtp: async () => ({ data: { session: null }, error: { message: "expired" } }) } };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await mintMcpToken({ accessToken: "at" }, { client, authClient } as any);

  expect(result).toEqual({ ok: false, status: 500, error: "Could not create token" });
  expect(insertFn).not.toHaveBeenCalled();
});

test("surfaces a 500 when the insert fails", async () => {
  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1", email: "user@example.com" } }, error: null }),
      admin: { generateLink: async () => okLink() },
    },
    from: () => ({ insert: async () => ({ error: { message: "db down" } }) }),
  };
  const authClient = { auth: { verifyOtp: async () => okVerify() } };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await mintMcpToken({ accessToken: "at" }, { client, authClient } as any);

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

test("handler mints a token end-to-end using env-configured clients, never forwarding a caller-supplied refresh_token", async () => {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  getUser.mockResolvedValue({ data: { user: { id: "user-1", email: "user@example.com" } }, error: null });
  generateLink.mockResolvedValue(okLink());
  verifyOtp.mockResolvedValue(okVerify());
  insert.mockResolvedValue({ error: null });

  const json = vi.fn();
  const status = vi.fn(() => ({ json }));

  await handler(
    // A caller-supplied refresh_token, if present, is intentionally ignored — the
    // mint flow never captures or stores the browser's own session tokens.
    { method: "POST", body: { access_token: "at", refresh_token: "browser-refresh-token" } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { status } as any,
  );

  expect(createClient).toHaveBeenCalledWith("https://example.supabase.co", "service-key");
  // Two distinct client instances: one for getUser + the mcp_sessions insert, one for verifyOtp.
  expect(vi.mocked(createClient).mock.calls.length).toBe(2);
  expect(status).toHaveBeenCalledWith(200);
  expect(json).toHaveBeenCalledWith({ token: expect.any(String) });
  expect(insert).toHaveBeenCalledWith(
    expect.objectContaining({ user_id: "user-1", refresh_token: "minted-refresh" }),
  );
});
