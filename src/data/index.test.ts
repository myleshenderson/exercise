import { afterEach, expect, test, vi } from "vitest";

// If anything imports supabase-js or src/data/supabase.ts (statically or via
// a dynamic import()), vitest runs the matching factory, so "never called"
// means "never in the module graph".
const supabaseJsFactory = vi.hoisted(() => vi.fn(() => ({ createClient: () => ({}) })));
vi.mock("@supabase/supabase-js", supabaseJsFactory);
const fakeSupabaseLayer = vi.hoisted(() => ({ listExercises: vi.fn(async () => [{ id: "from-supabase" }]) }));
const supabaseModuleFactory = vi.hoisted(() => vi.fn(() => ({ createSupabaseDataLayer: () => fakeSupabaseLayer })));
vi.mock("./supabase", supabaseModuleFactory);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  supabaseJsFactory.mockClear();
  supabaseModuleFactory.mockClear();
});

test("VITE_DATA_BACKEND=starkeep: db talks to the row API through the BASE_URL proxy and never loads Supabase", async () => {
  vi.stubEnv("VITE_DATA_BACKEND", "starkeep");
  vi.stubEnv("BASE_URL", "/apps/exercise/");
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rows: [], truncated: false, page_token: null })));
  vi.stubGlobal("fetch", fetchMock);

  const { db } = await import("./index");
  expect(await db.listExercises()).toEqual([]);
  expect(await db.getWorkoutDays()).toEqual([]);

  expect(fetchMock).toHaveBeenCalledWith(
    "/apps/exercise/api/local-data/app-data/db/exercises?where=%7B%22archived_at%22%3A%7B%22is%22%3Anull%7D%7D&order=name.asc&limit=500",
    { method: "GET", credentials: "include" },
  );
  expect(supabaseJsFactory).not.toHaveBeenCalled();
  expect(supabaseModuleFactory).not.toHaveBeenCalled();
});

test("default (mock) backend never loads Supabase", async () => {
  const { db } = await import("./index");
  expect((await db.getWorkoutDays()).length).toBeGreaterThan(0);
  expect(supabaseJsFactory).not.toHaveBeenCalled();
  expect(supabaseModuleFactory).not.toHaveBeenCalled();
});

test("VITE_DATA_BACKEND=supabase loads src/data/supabase.ts on first use and forwards to it", async () => {
  vi.stubEnv("VITE_DATA_BACKEND", "supabase");
  const { db } = await import("./index");
  expect(supabaseModuleFactory).not.toHaveBeenCalled();
  expect(await db.listExercises()).toEqual([{ id: "from-supabase" }]);
  expect(supabaseModuleFactory).toHaveBeenCalledTimes(1);
  expect(fakeSupabaseLayer.listExercises).toHaveBeenCalledTimes(1);
});
