import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";
import Login from "./Login";
import MCPLogin from "../screens/MCPLogin";

// If anything on the Starkeep path imports supabase-js (statically or through
// a dynamic import()), vitest runs this factory.
const supabaseFactory = vi.hoisted(() => vi.fn(() => ({ createClient: () => ({}) })));
vi.mock("@supabase/supabase-js", supabaseFactory);

beforeEach(() => {
  vi.stubEnv("VITE_DATA_BACKEND", "starkeep");
  vi.stubEnv("BASE_URL", "/apps/exercise/");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function AuthProbe() {
  const { session, loading } = useAuth();
  if (loading) return <p>loading</p>;
  if (!session) return <p>signed out</p>;
  const email = "kind" in session ? session.email : session.user.email;
  return <p>signed in as {email ?? "local"}</p>;
}

test("AuthContext reports signed in from the app server's session probe", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ signedIn: true, email: "me@example.com" }),
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<AuthProvider><AuthProbe /></AuthProvider>);

  expect(await screen.findByText("signed in as me@example.com")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/apps/exercise/api/session", { credentials: "same-origin" });
});

test("AuthContext reports signed out from a 401", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "Not authenticated" }) }));

  render(<AuthProvider><AuthProbe /></AuthProvider>);

  expect(await screen.findByText("signed out")).toBeInTheDocument();
});

test("AuthContext reports signed out when the probe says signedIn: false and the server has a user pool (cloud)", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/apps/exercise/starkeep-runtime-config") {
        return { ok: true, json: async () => ({ userPoolId: "us-east-1_abc" }) };
      }
      return { ok: true, json: async () => ({ signedIn: false }) };
    }),
  );

  render(<AuthProvider><AuthProbe /></AuthProvider>);

  expect(await screen.findByText("signed out")).toBeInTheDocument();
});

test("local Starkeep (no user pool, so no platform sign-in) reports the local user as signed in", async () => {
  vi.stubEnv("BASE_URL", "/");
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/starkeep-runtime-config") return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({ signedIn: false }) };
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<AuthProvider><AuthProbe /></AuthProvider>);

  expect(await screen.findByText("signed in as local")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/session", { credentials: "same-origin" });
});

test("AuthContext fails closed when the session probe and the runtime config both fail", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

  render(<AuthProvider><AuthProbe /></AuthProvider>);

  expect(await screen.findByText("signed out")).toBeInTheDocument();
});

test("MCPLogin asks to sign in again when the app server answers 401", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

  render(<MCPLogin />);
  fireEvent.click(screen.getByRole("button", { name: /generate token/i }));

  expect(await screen.findByText(/session has expired/i)).toBeInTheDocument();
});

test("Login renders the Starkeep sign-in action and no email form", () => {
  render(<Login />);
  expect(screen.getByRole("button", { name: /sign in with starkeep/i })).toBeInTheDocument();
  expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /magic link/i })).not.toBeInTheDocument();
});

test("MCPLogin calls the BASE_URL-relative endpoints and renders the token and its expiry", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/apps/exercise/api/mcp-sessions") {
      return { ok: true, json: async () => ({ sessions: [] }) };
    }
    return {
      ok: true,
      json: async () => ({ token: "exr_opaque", expires_at: "2026-12-07T00:00:00.000Z" }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<MCPLogin />);
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/apps/exercise/api/mcp-sessions",
      expect.objectContaining({ method: "POST", body: "{}" }),
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: /generate token/i }));

  expect(await screen.findByDisplayValue("exr_opaque")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    "/apps/exercise/api/mcp-login",
    expect.objectContaining({ method: "POST", body: "{}" }),
  );
  expect(
    screen.getByText(`Expires ${new Date("2026-12-07T00:00:00.000Z").toLocaleString()}`),
  ).toBeInTheDocument();
  expect(screen.getByDisplayValue(`${window.location.origin}/apps/exercise/mcp`)).toBeInTheDocument();
});

test("MCPLogin revokes through the BASE_URL-relative sessions endpoint", async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return { ok: true, json: async () => ({ ok: true }) };
    return {
      ok: true,
      json: async () => ({
        sessions: [{ id: "s1", createdAt: "2026-11-01T00:00:00Z", lastUsedAt: "2026-11-02T00:00:00Z" }],
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<MCPLogin />);
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

  await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument());
  expect(fetchMock).toHaveBeenCalledWith(
    "/apps/exercise/api/mcp-sessions",
    expect.objectContaining({ method: "DELETE", body: JSON.stringify({ session_id: "s1" }) }),
  );
});

test("nothing on the Starkeep path imports @supabase/supabase-js", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ signedIn: true, token: "t", sessions: [] }) }));

  render(
    <AuthProvider>
      <AuthProbe />
      <Login />
      <MCPLogin />
    </AuthProvider>,
  );
  await screen.findByText(/signed in/);
  fireEvent.click(screen.getByRole("button", { name: /generate token/i }));
  await screen.findByDisplayValue("t");

  expect(supabaseFactory).not.toHaveBeenCalled();
});
