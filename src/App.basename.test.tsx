import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RoutedApp } from "./App";

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.pushState({}, "", "/");
});

test("under a Starkeep cloud mount, /apps/exercise/days matches the /days route and links stay under the mount", async () => {
  vi.stubEnv("BASE_URL", "/apps/exercise/");
  window.history.pushState({}, "", "/apps/exercise/days");

  render(<RoutedApp />);

  expect(await screen.findByText("Manage Schedule")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Schedule" })).toHaveAttribute("href", "/apps/exercise/days");
  expect(screen.getByRole("link", { name: "MCP" })).toHaveAttribute("href", "/apps/exercise/mcp-login");
});

test("with BASE_URL=/ routing is unchanged", async () => {
  vi.stubEnv("BASE_URL", "/");
  window.history.pushState({}, "", "/days");

  render(<RoutedApp />);

  expect(await screen.findByText("Manage Schedule")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Schedule" })).toHaveAttribute("href", "/days");
});
