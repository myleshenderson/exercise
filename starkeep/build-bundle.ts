/**
 * Build the Exercise Lambda bundle (dist.zip) for a Starkeep cloud install.
 *
 * App-owned half of the install contract, modelled on photos'
 * `infra/build-bundle.ts`. The installer runs `pnpm bundle` in this directory:
 *
 *   env in:  STARKEEP_APP_BASE_PATH = /apps/exercise  (Vite `base`)
 *            STARKEEP_BUNDLE_OUT    = <abs path>      (where to write dist.zip)
 *   out:     dist.zip at STARKEEP_BUNDLE_OUT
 *
 * Unlike photos, both have defaults so `npm run bundle` works by hand:
 * `/apps/exercise` and `<repo>/dist.zip` (gitignored).
 *
 * Steps: build the SPA with Vite straight into the staging `assets/` dir (never
 * into `dist/`, which the local server and Vercel serve with base `/`), bundle
 * `starkeep/handler.ts` to `index.mjs` with esbuild, zip.
 *
 * `vite.config.ts` is shared with the Vercel build and is not edited for
 * Starkeep. The two Starkeep-only settings (`base` and the `_immutable` assets
 * dir) are passed inline here; Vite merges them over the config file.
 * `VITE_DATA_BACKEND=starkeep` comes from `spa-build.ts`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import manifest from "../starkeep.manifest.json" with { type: "json" };
import { buildStarkeepSpa } from "./spa-build.js";

const STARKEEP_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(STARKEEP_DIR, "..");


const APP_BASE_PATH = (process.env.STARKEEP_APP_BASE_PATH || `/apps/${manifest.id}`).replace(/\/+$/, "");
const BUNDLE_OUT = resolve(process.env.STARKEEP_BUNDLE_OUT || join(APP_DIR, "dist.zip"));

const staticHandler = manifest.infraRequirements.compute.handlers.find((h) => h.name === "static");
if (!staticHandler || staticHandler.staticAssetPaths.length === 0) {
  console.error(
    "exercise manifest has no `static` handler with staticAssetPaths, so the bundle would serve " +
      "neither the shell nor any asset; refusing to build it.",
  );
  process.exit(1);
}

/** Hono plus `@starkeep/app-client` plus the MCP SDK; anything near this is an accident. */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

async function buildBundle(appBasePath: string, distZip: string): Promise<void> {
  const staging = join(tmpdir(), `starkeep-exercise-bundle-${Date.now()}`);
  try {
    mkdirSync(staging, { recursive: true });

    // 1. The SPA, with every asset URL under the mount.
    const assets = join(staging, "assets");
    console.log(`\nBuilding the SPA with Vite (base ${appBasePath}/)…`);
    //    `buildStarkeepSpa` sets VITE_DATA_BACKEND=starkeep and checks the main chunk.
    await buildStarkeepSpa({
      root: APP_DIR,
      base: `${appBasePath}/`,
      mode: "production",
      build: { outDir: assets, emptyOutDir: true, assetsDir: "_immutable", sourcemap: false },
    });

    // 2. The Lambda entry. ESM `.mjs` for the top-level await in handler.ts;
    //    `index.handler` in the manifest resolves it.
    console.log("\nBundling the static Lambda entry with esbuild…");
    await esbuild({
      entryPoints: [join(STARKEEP_DIR, "handler.ts")],
      outfile: join(staging, "index.mjs"),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      external: ["node:*"],
      banner: {
        js: "import { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);",
      },
      logLevel: "warning",
    });
    const entryBytes = readFileSync(join(staging, "index.mjs")).length;
    if (entryBytes > MAX_ENTRY_BYTES) {
      throw new Error(
        `The Lambda entry is ${(entryBytes / 1024 / 1024).toFixed(1)} MB, over the ` +
          `${MAX_ENTRY_BYTES / 1024 / 1024} MB ceiling; something pulled a large dependency in.`,
      );
    }

    // 3. Zip, keeping `assets/` in shape because the adapter resolves under it.
    console.log("\nCreating dist.zip…");
    mkdirSync(dirname(distZip), { recursive: true });
    rmSync(distZip, { force: true });
    execFileSync("zip", ["-r", "-q", distZip, "."], { cwd: staging, stdio: "inherit" });
  } finally {
    // Errors above are thrown, not `process.exit`ed, so this always runs.
    rmSync(staging, { recursive: true, force: true });
  }
}

await buildBundle(APP_BASE_PATH, BUNDLE_OUT);
const bytes = readFileSync(BUNDLE_OUT).length;
console.log(`\nBundle written: ${BUNDLE_OUT} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
