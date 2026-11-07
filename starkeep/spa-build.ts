/**
 * The Starkeep build of the SPA, shared by the local server (`serve.ts`, which
 * builds `dist/`) and the cloud bundle (`build-bundle.ts`, which builds into
 * the zip's `assets/`).
 *
 * Vite bakes `import.meta.env` in at build time, and nothing else sets
 * `VITE_DATA_BACKEND` for a Starkeep install (the repo has no `.env`, and
 * `vite.config.ts` is shared with the Vercel build), so an unset variable
 * would ship the mock backend (AI-607). `buildStarkeepSpa` sets it for the
 * duration of the build, checks that Vite resolved it, and checks the emitted
 * main chunk.
 *
 * The minifier folds `isStarkeepBackend()` to a constant, so the chunk check
 * cannot look for the string `starkeep`. It looks for the Starkeep-only
 * `app_meta` table instead, which only the Starkeep DataLayer names, and for
 * the absence of supabase-js (which lives in the lazily loaded
 * `supabaseClient-*.js` chunk).
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { InlineConfig, Plugin } from "vite";

export const STARKEEP_BACKEND = "starkeep";

/**
 * Written into `dist/` by the local server's build, holding the backend the
 * build was made for. A plain `npm run build` (Vercel/mock) empties `dist/`
 * and leaves none, so the local server rebuilds it.
 */
export const BACKEND_MARKER = ".starkeep-backend";

/** A table only the Starkeep DataLayer names; see the module comment. */
export const STARKEEP_ONLY_TABLE = "app_meta";

/** A supabase-js error string; it must not be in the main chunk. */
export const SUPABASE_JS_SIGNATURE = "supabaseUrl is required";

/** What the client build reads, as paths under the package. */
export const CLIENT_INPUTS = [
  "src",
  "public",
  "index.html",
  "vite.config.ts",
  "tailwind.config.js",
  "postcss.config.js",
  "tsconfig.json",
  "tsconfig.app.json",
  "package.json",
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
];

/** The newest mtime under a path, directory or file, or 0 when absent. */
export function newestMtime(path: string): number {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, entry)));
  return newest;
}

/**
 * Why `distDir` needs a rebuild before the local server can serve it, or
 * `null` when it is a current Starkeep build.
 */
export function distRebuildReason(pkgDir: string, distDir: string): string | null {
  const built = newestMtime(join(distDir, "index.html"));
  if (built === 0) return "missing";
  const markerPath = join(distDir, BACKEND_MARKER);
  const markerTime = newestMtime(markerPath);
  // An older marker means something else rebuilt the shell over a Starkeep
  // build without emptying `dist/`.
  if (markerTime < built || readFileSync(markerPath, "utf8").trim() !== STARKEEP_BACKEND) {
    return "not a Starkeep build";
  }
  if (CLIENT_INPUTS.some((p) => newestMtime(join(pkgDir, p)) > built)) return "older than its sources";
  return null;
}

/** The entry `<script type="module" src>` of a built shell, as a file under `outDir`. */
export function mainChunkPath(outDir: string, base = "/"): string {
  const html = readFileSync(join(outDir, "index.html"), "utf8");
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    if (!/\btype="module"/.test(tag)) continue;
    const src = /\bsrc="([^"]+)"/.exec(tag)?.[1];
    if (!src) continue;
    const prefix = base.endsWith("/") ? base : `${base}/`;
    const relative = src.startsWith(prefix) ? src.slice(prefix.length) : src.replace(/^\/+/, "");
    return join(outDir, relative);
  }
  throw new Error(`No <script type="module" src> in ${join(outDir, "index.html")}.`);
}

/** Throws unless the main chunk of the build in `outDir` is a Starkeep-backend build. */
export function assertStarkeepMainChunk(outDir: string, base = "/"): void {
  const chunk = mainChunkPath(outDir, base);
  const code = readFileSync(chunk, "utf8");
  if (code.includes(SUPABASE_JS_SIGNATURE)) {
    throw new Error(`${chunk} bundles supabase-js ("${SUPABASE_JS_SIGNATURE}"); a Starkeep build must not.`);
  }
  if (!code.includes(STARKEEP_ONLY_TABLE)) {
    throw new Error(
      `${chunk} never names the \`${STARKEEP_ONLY_TABLE}\` table, so it is not the Starkeep DataLayer ` +
        "(VITE_DATA_BACKEND was not starkeep when Vite built it).",
    );
  }
}

export interface StarkeepBuildOptions {
  /** Write {@link BACKEND_MARKER} into the output directory (the local server's `dist/`). */
  marker?: boolean;
}

/**
 * `vite build` with `VITE_DATA_BACKEND=starkeep`, whatever the caller's
 * environment says. `config` is merged over `vite.config.ts` as usual.
 * Returns the absolute output directory.
 */
export async function buildStarkeepSpa(config: InlineConfig, options: StarkeepBuildOptions = {}): Promise<string> {
  let resolvedBackend: string | undefined;
  let outDir: string | undefined;
  let base = "/";
  const probe: Plugin = {
    name: "exercise:starkeep-backend-probe",
    configResolved(resolved) {
      resolvedBackend = resolved.env.VITE_DATA_BACKEND as string | undefined;
      outDir = resolve(resolved.root, resolved.build.outDir);
      base = resolved.base;
    },
  };

  const previous = process.env.VITE_DATA_BACKEND;
  // Vite's loadEnv gives variables already in process.env priority over `.env*` files.
  process.env.VITE_DATA_BACKEND = STARKEEP_BACKEND;
  try {
    const { build } = await import("vite");
    await build({ ...config, plugins: [...(config.plugins ?? []), probe] });
  } finally {
    if (previous === undefined) delete process.env.VITE_DATA_BACKEND;
    else process.env.VITE_DATA_BACKEND = previous;
  }

  if (resolvedBackend !== STARKEEP_BACKEND || outDir === undefined) {
    throw new Error(`Vite resolved VITE_DATA_BACKEND=${String(resolvedBackend)}, expected ${STARKEEP_BACKEND}.`);
  }
  assertStarkeepMainChunk(outDir, base);
  if (options.marker) writeFileSync(join(outDir, BACKEND_MARKER), `${STARKEEP_BACKEND}\n`);
  return outDir;
}
