// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { resolveIdentity } from "./mcp-auth.js";
import { sha256Hex } from "./mcp-login.js";

function fakeClient(overrides: {
  row?: { id: string; user_id: string; refresh_token: string } | null;
  lookupError?: { message: string } | null;
  refreshSession?: () => Promise<{ data: { session: { access_token: string; refresh_token: string } | null }; error: { message: string } | null }>;
  updateError?: { message: string } | null;
}) {
  const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: overrides.updateError ?? null })) }));
  return {
    // Deliberately has no .auth — mirrors AuthDeps.client's type, so a regression that
    // calls deps.client.auth.refreshSession() again fails to typecheck, not just at runtime.
    client: {
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: overrides.row ?? null, error: overrides.lookupError ?? null }),
          }),
        }),
        update,
      })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // Deliberately has no .from — refreshSession must never be asked to persist anything.
    authClient: {
      auth: {
        refreshSession:
          overrides.refreshSession ??
          (async () => ({
            data: { session: { access_token: "fresh-access", refresh_token: "rotated-refresh" } },
            error: null,
          })),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    update,
  };
}

describe("resolveIdentity", () => {
  it("rejects a missing bearer token without touching the session store", async () => {
    const { client, authClient } = fakeClient({});
    const result = await resolveIdentity(undefined, { client, authClient });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("Missing bearer token") });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("rejects a bearer token with no matching session row", async () => {
    const { client, authClient } = fakeClient({ row: null });
    const result = await resolveIdentity("nope", { client, authClient });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("Invalid bearer token") });
  });

  it("reports a transient session-store lookup failure distinctly from an invalid token", async () => {
    const { client, authClient } = fakeClient({ row: null, lookupError: { message: "connection reset" } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await resolveIdentity("token", { client, authClient });

    expect(result).toEqual({ ok: false, error: expect.not.stringContaining("Invalid bearer token") });
    expect((result as { error: string }).error).toContain("try again");
    errorSpy.mockRestore();
  });

  it("rejects when the stored refresh_token has already been used/expired", async () => {
    const { client, authClient } = fakeClient({
      row: { id: "row-1", user_id: "user-1", refresh_token: "stale" },
      refreshSession: async () => ({ data: { session: null }, error: { message: "invalid grant" } }),
    });

    const result = await resolveIdentity("token", { client, authClient });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("session has expired") });
  });

  it("surfaces an error when the rotated refresh_token can't be persisted", async () => {
    const { client, authClient } = fakeClient({
      row: { id: "row-1", user_id: "user-1", refresh_token: "old" },
      updateError: { message: "db down" },
    });

    const result = await resolveIdentity("token", { client, authClient });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("Could not persist") });
  });

  it("resolves the caller's identity and writes the rotated refresh_token back", async () => {
    const { client, authClient, update } = fakeClient({
      row: { id: "row-1", user_id: "user-1", refresh_token: "old" },
    });

    const result = await resolveIdentity("token", { client, authClient });

    expect(result).toEqual({ ok: true, userId: "user-1", accessToken: "fresh-access" });
    expect(update).toHaveBeenCalledWith({ refresh_token: "rotated-refresh", last_used_at: expect.any(String) });
  });

  it("records last_used_at as the current time whenever a session is used", async () => {
    const { client, authClient, update } = fakeClient({
      row: { id: "row-1", user_id: "user-1", refresh_token: "old" },
    });

    const before = Date.now();
    await resolveIdentity("token", { client, authClient });
    const after = Date.now();

    const patch = update.mock.calls[0][0] as { last_used_at: string };
    const recorded = new Date(patch.last_used_at).getTime();
    expect(recorded).toBeGreaterThanOrEqual(before);
    expect(recorded).toBeLessThanOrEqual(after);
  });

  it("persists the rotated refresh_token via the table client even after the auth client's session changes", async () => {
    // Regression test for the production bug: resolveIdentity used to call
    // .auth.refreshSession() and .from().update() on the SAME client instance.
    // supabase-js swaps that client's ambient session on a successful refresh, so the
    // update silently ran as the refreshed user (role "authenticated") instead of the
    // service-role identity — mcp_sessions only grants service_role, so the write hit
    // 42501 in production while every mocked test (which shares one object) stayed green.
    // authClient here exposes no .from at all, so persisting through it isn't just
    // wrong, it's a type error — this test's assertion is the runtime half of that guard.
    const { client, authClient, update } = fakeClient({
      row: { id: "row-1", user_id: "user-1", refresh_token: "old" },
    });

    await resolveIdentity("token", { client, authClient });

    expect(client.from).toHaveBeenCalledWith("mcp_sessions");
    expect(update).toHaveBeenCalledWith({ refresh_token: "rotated-refresh", last_used_at: expect.any(String) });
  });

  it("retries once when a concurrent call for the same session already rotated the refresh_token", async () => {
    // Simulates two tool calls racing on one session: both read refresh_token
    // "attempt-0", but a concurrent caller wins the exchange first and rotates the
    // row to "attempt-1" before this call's own exchange is attempted.
    const state = { refreshToken: "attempt-0" };
    const refreshCalls: string[] = [];

    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: "row-1", user_id: "user-1", refresh_token: state.refreshToken },
              error: null,
            }),
          }),
        }),
        update: (patch: { refresh_token: string }) => ({
          eq: async () => {
            state.refreshToken = patch.refresh_token;
            return { error: null };
          },
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const authClient = {
      auth: {
        refreshSession: async ({ refresh_token }: { refresh_token: string }) => {
          refreshCalls.push(refresh_token);
          if (refresh_token === "attempt-0") {
            state.refreshToken = "attempt-1"; // the concurrent caller's rotation lands here
            return { data: { session: null }, error: { message: "invalid grant" } };
          }
          return { data: { session: { access_token: "fresh-access", refresh_token: "attempt-2" } }, error: null };
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await resolveIdentity("token", { client, authClient });

    expect(result).toEqual({ ok: true, userId: "user-1", accessToken: "fresh-access" });
    expect(refreshCalls).toEqual(["attempt-0", "attempt-1"]);
    expect(state.refreshToken).toBe("attempt-2");
  });

  it("gives up with a session-expired error once retries are exhausted, rather than retrying forever", async () => {
    // Each refetch returns a new refresh_token (as if a different concurrent caller
    // keeps winning), but every exchange attempt fails regardless — the retry loop
    // must still terminate rather than looping on ever-changing tokens forever.
    let generation = 0;
    const refreshCalls: string[] = [];
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: "row-1", user_id: "user-1", refresh_token: `gen-${generation}` },
              error: null,
            }),
          }),
        }),
        update: () => ({ eq: async () => ({ error: null }) }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const authClient = {
      auth: {
        refreshSession: async ({ refresh_token }: { refresh_token: string }) => {
          refreshCalls.push(refresh_token);
          generation += 1;
          return { data: { session: null }, error: { message: "invalid grant" } };
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await resolveIdentity("token", { client, authClient });

    expect(result).toEqual({ ok: false, error: expect.stringContaining("session has expired") });
    expect(refreshCalls).toEqual(["gen-0", "gen-1", "gen-2"]);
  });

  it("looks the token up by its sha256 hash, never the raw value", async () => {
    const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: null, error: null }) }));
    const client = {
      from: () => ({ select: () => ({ eq }), update: () => ({ eq: async () => ({ error: null }) }) }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const authClient = {
      auth: { refreshSession: vi.fn() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await resolveIdentity("raw-token", { client, authClient });

    expect(eq).toHaveBeenCalledWith("token", sha256Hex("raw-token"));
  });
});
