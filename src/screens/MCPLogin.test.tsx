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

test("shows an error when the response has no token", async () => {
  getSession.mockResolvedValue({ data: { session: { access_token: "at", refresh_token: "rt" } } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

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

test("shows the MCP endpoint URL", () => {
  render(<MCPLogin />);
  expect(screen.getByDisplayValue("http://localhost:3000/api/mcp")).toBeInTheDocument();
});

test("shows the available tools", () => {
  render(<MCPLogin />);
  expect(screen.getByText("progression_for_exercise")).toBeInTheDocument();
  expect(screen.getByText("sets_for_exercise")).toBeInTheDocument();
  expect(screen.getByText("weekly_volume")).toBeInTheDocument();
  expect(screen.getByText("training_gaps")).toBeInTheDocument();
  expect(screen.getByText("get_day_templates")).toBeInTheDocument();
  expect(screen.getByText("get_workout_history")).toBeInTheDocument();
  expect(screen.getByText("scheme_history_for_day_exercise")).toBeInTheDocument();
});

test("shows a client config snippet with a placeholder before a token is generated", () => {
  render(<MCPLogin />);
  expect((screen.getByLabelText("Claude Code CLI") as HTMLTextAreaElement).value).toContain("YOUR_TOKEN");
  const jsonValue = (screen.getByLabelText("mcpServers JSON") as HTMLTextAreaElement).value;
  const parsed = JSON.parse(jsonValue);
  expect(parsed.mcpServers["exercise-mcp"]).toEqual({
    command: "npx",
    args: [
      "-y",
      "mcp-remote",
      `${window.location.origin}/api/mcp`,
      "--transport",
      "http-only",
      "--header",
      "Authorization: Bearer ${EXERCISE_MCP_TOKEN}",
    ],
    env: { EXERCISE_MCP_TOKEN: "YOUR_TOKEN" },
  });
});

test("shows a client config snippet with the real token once generated", async () => {
  getSession.mockResolvedValue({ data: { session: { access_token: "at", refresh_token: "rt" } } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: "opaque-token-123" }) }));

  render(<MCPLogin />);
  fireEvent.click(screen.getByRole("button", { name: /generate token/i }));

  await waitFor(() =>
    expect((screen.getByLabelText("Claude Code CLI") as HTMLTextAreaElement).value).toContain("opaque-token-123"),
  );
  const jsonValue = (screen.getByLabelText("mcpServers JSON") as HTMLTextAreaElement).value;
  expect(jsonValue).toContain("opaque-token-123");
  const parsed = JSON.parse(jsonValue);
  expect(parsed.mcpServers["exercise-mcp"]).toEqual({
    command: "npx",
    args: [
      "-y",
      "mcp-remote",
      `${window.location.origin}/api/mcp`,
      "--transport",
      "http-only",
      "--header",
      "Authorization: Bearer ${EXERCISE_MCP_TOKEN}",
    ],
    env: { EXERCISE_MCP_TOKEN: "opaque-token-123" },
  });
  expect((screen.getByLabelText("Claude Code CLI") as HTMLTextAreaElement).value).not.toContain("YOUR_TOKEN");
});

test("allows generating a new token after the first one", async () => {
  getSession.mockResolvedValue({ data: { session: { access_token: "at", refresh_token: "rt" } } });
  let mintCalls = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/mcp-sessions") return { ok: true, json: async () => ({ sessions: [] }) };
    mintCalls += 1;
    return { ok: true, json: async () => ({ token: mintCalls === 1 ? "first" : "second" }) };
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<MCPLogin />);
  fireEvent.click(screen.getByRole("button", { name: /generate token/i }));
  await waitFor(() => expect(screen.getByDisplayValue("first")).toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: /generate new token/i }));
  await waitFor(() => expect(screen.getByDisplayValue("second")).toBeInTheDocument());
});

test("loads and lists active MCP sessions", async () => {
  getSession.mockResolvedValue({ data: { session: { access_token: "at", refresh_token: "rt" } } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/mcp-sessions") {
        return {
          ok: true,
          json: async () => ({
            sessions: [
              { id: "s1", createdAt: "2026-09-01T00:00:00.000Z", lastUsedAt: "2026-09-02T00:00:00.000Z" },
              { id: "s2", createdAt: "2026-08-01T00:00:00.000Z", lastUsedAt: "2026-08-01T00:00:00.000Z" },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ token: "x" }) };
    }),
  );

  render(<MCPLogin />);

  await waitFor(() => expect(screen.getByText(/active sessions/i)).toBeInTheDocument());
  expect(screen.getAllByRole("button", { name: /revoke/i })).toHaveLength(2);
});

test("hides the active sessions section when there are no sessions", async () => {
  getSession.mockResolvedValue({ data: { session: { access_token: "at", refresh_token: "rt" } } });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ sessions: [] }) })));

  render(<MCPLogin />);

  await waitFor(() => expect(getSession).toHaveBeenCalled());
  expect(screen.queryByText(/active sessions/i)).not.toBeInTheDocument();
});

test("revokes a session and removes it from the list", async () => {
  getSession.mockResolvedValue({ data: { session: { access_token: "at", refresh_token: "rt" } } });
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    if (url === "/api/mcp-sessions" && init?.method === "DELETE") {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (url === "/api/mcp-sessions") {
      return {
        ok: true,
        json: async () => ({
          sessions: [{ id: "s1", createdAt: "2026-09-01T00:00:00.000Z", lastUsedAt: "2026-09-01T00:00:00.000Z" }],
        }),
      };
    }
    return { ok: true, json: async () => ({ token: "x" }) };
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<MCPLogin />);
  await waitFor(() => expect(screen.getByRole("button", { name: /revoke/i })).toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

  await waitFor(() => expect(screen.queryByRole("button", { name: /revoke/i })).not.toBeInTheDocument());
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/mcp-sessions",
    expect.objectContaining({ method: "DELETE", body: JSON.stringify({ access_token: "at", session_id: "s1" }) }),
  );
});

test("shows an error if revoking a session fails", async () => {
  getSession.mockResolvedValue({ data: { session: { access_token: "at", refresh_token: "rt" } } });
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    if (url === "/api/mcp-sessions" && init?.method === "DELETE") {
      return { ok: false, json: async () => ({}) };
    }
    if (url === "/api/mcp-sessions") {
      return {
        ok: true,
        json: async () => ({
          sessions: [{ id: "s1", createdAt: "2026-09-01T00:00:00.000Z", lastUsedAt: "2026-09-01T00:00:00.000Z" }],
        }),
      };
    }
    return { ok: true, json: async () => ({ token: "x" }) };
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<MCPLogin />);
  await waitFor(() => expect(screen.getByRole("button", { name: /revoke/i })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

  await waitFor(() => expect(screen.getByText(/could not revoke/i)).toBeInTheDocument());
});
