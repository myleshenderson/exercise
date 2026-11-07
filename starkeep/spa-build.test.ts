// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  assertStarkeepMainChunk,
  BACKEND_MARKER,
  buildStarkeepSpa,
  distRebuildReason,
  mainChunkPath,
  STARKEEP_BACKEND,
  STARKEEP_ONLY_TABLE,
  SUPABASE_JS_SIGNATURE,
} from "./spa-build.js";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_TIMEOUT = 180_000;

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "exercise-spa-build-"));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("buildStarkeepSpa (real vite build)", () => {
  const env = process.env.VITE_DATA_BACKEND;
  afterEach(() => {
    if (env === undefined) delete process.env.VITE_DATA_BACKEND;
    else process.env.VITE_DATA_BACKEND = env;
  });

  it(
    "builds the local server's dist/ for the Starkeep backend, writes the marker and restores the env",
    async () => {
      // Even a caller whose shell says otherwise gets a Starkeep build.
      process.env.VITE_DATA_BACKEND = "mock";
      const outDir = join(tempDir(), "dist");
      const built = await buildStarkeepSpa(
        { root: APP_DIR, logLevel: "warn", build: { outDir, emptyOutDir: true } },
        { marker: true },
      );
      expect(built).toBe(outDir);
      expect(process.env.VITE_DATA_BACKEND).toBe("mock");

      const main = readFileSync(mainChunkPath(outDir), "utf8");
      expect(main).not.toContain(SUPABASE_JS_SIGNATURE);
      expect(main).toContain(STARKEEP_ONLY_TABLE);
      expect(readFileSync(join(outDir, BACKEND_MARKER), "utf8").trim()).toBe(STARKEEP_BACKEND);
    },
    BUILD_TIMEOUT,
  );

  it(
    "builds the cloud bundle's assets/ (base /apps/exercise/, _immutable) for the Starkeep backend",
    async () => {
      delete process.env.VITE_DATA_BACKEND;
      const outDir = join(tempDir(), "assets");
      await buildStarkeepSpa({
        root: APP_DIR,
        base: "/apps/exercise/",
        mode: "production",
        logLevel: "warn",
        build: { outDir, emptyOutDir: true, assetsDir: "_immutable", sourcemap: false },
      });
      const chunk = mainChunkPath(outDir, "/apps/exercise/");
      expect(chunk.startsWith(join(outDir, "_immutable") + "/")).toBe(true);
      const main = readFileSync(chunk, "utf8");
      expect(main).not.toContain(SUPABASE_JS_SIGNATURE);
      expect(main).toContain(STARKEEP_ONLY_TABLE);
      expect(process.env.VITE_DATA_BACKEND).toBeUndefined();
    },
    BUILD_TIMEOUT,
  );

  it(
    "assertStarkeepMainChunk rejects a plain (mock) vite build",
    async () => {
      delete process.env.VITE_DATA_BACKEND;
      const outDir = join(tempDir(), "dist");
      const { build } = await import("vite");
      await build({ root: APP_DIR, logLevel: "warn", build: { outDir, emptyOutDir: true } });
      expect(() => assertStarkeepMainChunk(outDir)).toThrow(/not the Starkeep DataLayer/);
    },
    BUILD_TIMEOUT,
  );
});

describe("distRebuildReason", () => {
  /** A package with one source file at t=1000s and a dist/ whose shell is at `shellAt`. */
  function fixture(shellAt: number, marker?: { content: string; at: number }) {
    const pkg = tempDir();
    mkdirSync(join(pkg, "src"));
    writeFileSync(join(pkg, "src", "main.tsx"), "");
    utimesSync(join(pkg, "src", "main.tsx"), 1000, 1000);
    const dist = join(pkg, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "index.html"), "<html></html>");
    utimesSync(join(dist, "index.html"), shellAt, shellAt);
    if (marker) {
      writeFileSync(join(dist, BACKEND_MARKER), marker.content);
      utimesSync(join(dist, BACKEND_MARKER), marker.at, marker.at);
    }
    return { pkg, dist };
  }

  it("is missing without a shell", () => {
    const pkg = tempDir();
    expect(distRebuildReason(pkg, join(pkg, "dist"))).toBe("missing");
  });

  it("rebuilds a plain `npm run build` dist/ (no marker) even when newer than the sources", () => {
    const { pkg, dist } = fixture(2000);
    expect(distRebuildReason(pkg, dist)).toBe("not a Starkeep build");
  });

  it("rebuilds when the marker names another backend", () => {
    const { pkg, dist } = fixture(2000, { content: "mock\n", at: 2000 });
    expect(distRebuildReason(pkg, dist)).toBe("not a Starkeep build");
  });

  it("rebuilds when the shell was rebuilt after the marker", () => {
    const { pkg, dist } = fixture(3000, { content: `${STARKEEP_BACKEND}\n`, at: 2000 });
    expect(distRebuildReason(pkg, dist)).toBe("not a Starkeep build");
  });

  it("rebuilds a Starkeep build older than its sources", () => {
    const { pkg, dist } = fixture(500, { content: `${STARKEEP_BACKEND}\n`, at: 500 });
    expect(distRebuildReason(pkg, dist)).toBe("older than its sources");
  });

  it("keeps a current Starkeep build", () => {
    const { pkg, dist } = fixture(2000, { content: `${STARKEEP_BACKEND}\n`, at: 2000 });
    expect(distRebuildReason(pkg, dist)).toBeNull();
  });
});
