// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { resolveIdentity } from "./mcp-auth";
import { sha256Hex } from "./mcp-login";

function fakeClient(overrides: {
  row?: { id: string; user_id: string; refresh_token: string } | null;
  lookupError?: { message: string } | null;
  refreshSession?: () => Promise<{ data: { session: { access_token: string; refresh_token: string } | null }; error: { message: string } | null }>;
  updateError?: { message: string } | null;
}) {
  const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: overrides.updateError ?? null })) }));
  return {
    client: {
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: overrides.row ?? null, error: overrides.lookupError ?? null }),
          }),
        }),
        update,
      })),
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
    const { client } = fakeClient({});
    const result = await resolveIdentity(undefined, { client });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("Missing bearer token") });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("rejects a bearer token with no matching session row", async () => {
    const { client } = fakeClient({ row: null });
    const result = await resolveIdentity("nope", { client });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("Invalid bearer token") });
  });

  it("reports a transient session-store lookup failure distinctly from an invalid token", async () => {
    const { client } = fakeClient({ row: null, lookupError: { message: "connection reset" } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await resolveIdentity("token", { client });

    expect(result).toEqual({ ok: false, error: expect.not.stringContaining("Invalid bearer token") });
    expect((result as { error: string }).error).toContain("try again");
    errorSpy.mockRestore();
  });

  it("rejects when the stored refresh_token has already been used/expired", async () => {
    const { client } = fakeClient({
      row: { id: "row-1", user_id: "user-1", refresh_token: "stale" },
      refreshSession: async () => ({ data: { session: null }, error: { message: "invalid grant" } }),
    });

    const result = await resolveIdentity("token", { client });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("session has expired") });
  });

  it("surfaces an error when the rotated refresh_token can't be persisted", async () => {
    const { client } = fakeClient({
      row: { id: "row-1", user_id: "user-1", refresh_token: "old" },
      updateError: { message: "db down" },
    });

    const result = await resolveIdentity("token", { client });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("Could not persist") });
  });

  it("resolves the caller's identity and writes the rotated refresh_token back", async () => {
    const { client, update } = fakeClient({
      row: { id: "row-1", user_id: "user-1", refresh_token: "old" },
    });

    const result = await resolveIdentity("token", { client });

    expect(result).toEqual({ ok: true, userId: "user-1", accessToken: "fresh-access" });
    expect(update).toHaveBeenCalledWith({ refresh_token: "rotated-refresh" });
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

    const result = await resolveIdentity("token", { client });

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
      auth: {
        refreshSession: async ({ refresh_token }: { refresh_token: string }) => {
          refreshCalls.push(refresh_token);
          generation += 1;
          return { data: { session: null }, error: { message: "invalid grant" } };
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await resolveIdentity("token", { client });

    expect(result).toEqual({ ok: false, error: expect.stringContaining("session has expired") });
    expect(refreshCalls).toEqual(["gen-0", "gen-1", "gen-2"]);
  });

  it("looks the token up by its sha256 hash, never the raw value", async () => {
    const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: null, error: null }) }));
    const client = {
      from: () => ({ select: () => ({ eq }), update: () => ({ eq: async () => ({ error: null }) }) }),
      auth: { refreshSession: vi.fn() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await resolveIdentity("raw-token", { client });

    expect(eq).toHaveBeenCalledWith("token", sha256Hex("raw-token"));
  });
});
