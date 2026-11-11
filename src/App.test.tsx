import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App";

test("renders home route", () => {
  render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
  expect(screen.getAllByText("Home")[0]).toBeInTheDocument();
});

test("/sign-in sends an already-usable app to the Home screen", async () => {
  // The cloud redirects a signed-out browser here; once a session exists (or the
  // backend needs none) the path should not strand the person on an empty shell.
  render(<MemoryRouter initialEntries={["/sign-in"]}><App /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
});

test.each([
  ["/activities", "Activities", "activities"],
  ["/activities/some-id", "Activity", "activity"],
  ["/stats", "My Stats", "stats-cycling"],
  ["/stats?tab=strength", "My Stats", "stats-strength"],
  ["/training", "Training", "training"],
  ["/power", "Power curve", "power"],
  ["/weight", "Weight", "weight"],
  ["/settings", "Settings", "settings"],
])("%s renders its placeholder with the empty state", async (path, heading, ready) => {
  const { container } = render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
  expect(screen.getByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
  expect(screen.getByText(/No rides yet\. The sync fills this in; see/)).toBeInTheDocument();
  await waitFor(() => expect(container.querySelector(`[data-ready="${ready}"]`)).not.toBeNull());
});

test("bottom nav has six links with Activities and Stats between Workouts and MCP", () => {
  render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
  const links = Array.from(document.querySelectorAll("nav a")).map((a) => [a.textContent, a.getAttribute("href")]);
  expect(links).toEqual([
    ["Home", "/"],
    ["Schedule", "/days"],
    ["Workouts", "/workouts"],
    ["Activities", "/activities"],
    ["Stats", "/stats"],
    ["MCP", "/mcp-login"],
  ]);
});

test("the empty state and the My Stats gear both link to Settings", () => {
  render(<MemoryRouter initialEntries={["/stats"]}><App /></MemoryRouter>);
  expect(screen.getAllByRole("link", { name: "Settings" }).map((a) => a.getAttribute("href"))).toEqual(["/settings", "/settings"]);
});
