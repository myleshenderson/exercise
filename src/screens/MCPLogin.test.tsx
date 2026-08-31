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
});

test("shows a client config snippet with a placeholder before a token is generated", () => {
  render(<MCPLogin />);
  expect((screen.getByLabelText("Claude Code CLI") as HTMLTextAreaElement).value).toContain("YOUR_TOKEN");
  expect((screen.getByLabelText("mcpServers JSON") as HTMLTextAreaElement).value).toContain("YOUR_TOKEN");
});

test("shows a client config snippet with the real token once generated", async () => {
  getSession.mockResolvedValue({ data: { session: { access_token: "at", refresh_token: "rt" } } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: "opaque-token-123" }) }));

  render(<MCPLogin />);
  fireEvent.click(screen.getByRole("button", { name: /generate token/i }));

  await waitFor(() =>
    expect((screen.getByLabelText("Claude Code CLI") as HTMLTextAreaElement).value).toContain("opaque-token-123"),
  );
  expect((screen.getByLabelText("mcpServers JSON") as HTMLTextAreaElement).value).toContain("opaque-token-123");
  expect((screen.getByLabelText("Claude Code CLI") as HTMLTextAreaElement).value).not.toContain("YOUR_TOKEN");
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
