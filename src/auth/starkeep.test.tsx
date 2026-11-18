import { render, screen, waitFor } from "@testing-library/react";
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

test("Login renders the Starkeep sign-in action and no email form", () => {
  render(<Login />);
  expect(screen.getByRole("button", { name: /sign in with starkeep/i })).toBeInTheDocument();
  expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /magic link/i })).not.toBeInTheDocument();
});

// The shape a cloud deployment serves: the browser-facing base is the
// CloudFront distribution, and the consent pages answer on the gateway's own
// execute-api host, under the stage.
const GATEWAY = "https://abc123.execute-api.us-east-1.amazonaws.com/prod";
const CLOUD_RUNTIME_CONFIG = {
  apiGatewayUrl: "https://d111111abcdef8.cloudfront.net",
  region: "us-east-1",
  userPoolId: "us-east-1_abc",
  userPoolClientId: "client123",
  identityPoolId: "us-east-1:pool",
  connectUrl: `${GATEWAY}/connect?app=exercise`,
  connectionsUrl: `${GATEWAY}/connections`,
};

test("MCPLogin in the cloud shows the endpoint and the platform's connect and connections pages", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/apps/exercise/starkeep-runtime-config") {
      return { ok: true, json: async () => CLOUD_RUNTIME_CONFIG };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<MCPLogin />);

  const endpoint = `${window.location.origin}/apps/exercise/mcp`;
  expect(screen.getByDisplayValue(endpoint)).toBeInTheDocument();
  // OAuth: the client is added with no header and signs in on the platform.
  expect((screen.getByLabelText("Claude Code CLI") as HTMLTextAreaElement).value).toBe(
    `claude mcp add --transport http exercise ${endpoint}`,
  );
  expect(await screen.findByRole("link", { name: "Create a token" })).toHaveAttribute(
    "href",
    `${GATEWAY}/connect?app=exercise`,
  );
  expect(screen.getByRole("link", { name: "Manage connections" })).toHaveAttribute("href", `${GATEWAY}/connections`);
  expect((screen.getByLabelText("Claude Code CLI with a token") as HTMLTextAreaElement).value).toContain(
    'Authorization: Bearer YOUR_TOKEN',
  );
  // Exercise no longer mints or lists tokens itself.
  expect(screen.queryByRole("button", { name: /generate/i })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/apps/exercise/starkeep-runtime-config"]);
});

test("MCPLogin on the local surface says no token is needed and links to no platform page", async () => {
  vi.stubEnv("BASE_URL", "/");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

  render(<MCPLogin />);

  expect(await screen.findByText(/needs no token/i)).toBeInTheDocument();
  expect(screen.getByDisplayValue(`${window.location.origin}/mcp`)).toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

test("MCPLogin claims neither surface when the runtime config cannot be read", async () => {
  const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
  vi.stubGlobal("fetch", fetchMock);

  render(<MCPLogin />);

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.getByDisplayValue(`${window.location.origin}/apps/exercise/mcp`)).toBeInTheDocument();
  expect(screen.queryByText(/needs no token/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

test("nothing on the Starkeep path imports @supabase/supabase-js", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ signedIn: true, ...CLOUD_RUNTIME_CONFIG }) }));

  render(
    <AuthProvider>
      <AuthProbe />
      <Login />
      <MCPLogin />
    </AuthProvider>,
  );
  await screen.findByText(/signed in/);
  await screen.findByRole("link", { name: "Manage connections" });

  expect(supabaseFactory).not.toHaveBeenCalled();
});
