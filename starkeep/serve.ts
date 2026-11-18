/**
 * Exercise's local Starkeep surface: the platform's `serveLocal` in front of
 * the same Hono app the Lambda runs, with the built SPA (`dist/`) beside it.
 *
 * admin-web starts this from the manifest's `localRun`:
 *
 *     npm run starkeep:serve -- --port <port>
 *
 * `--port` is the manifest `portFlag`; `PORT` is the fallback for a person
 * running it by hand.
 *
 * `serveLocal` binds `127.0.0.1`, refuses a request with a non-loopback `Host`
 * or from a page on another site before any route runs, and answers the
 * build's files with the static responder the cloud Lambda runs, over the same
 * paths (`client-routes.ts`, `staticOptions`). Everything else goes to the
 * Hono app.
 *
 * Before it starts, the server rebuilds `dist/` when the build is missing,
 * older than its sources, or not a Starkeep-backend build (a plain
 * `npm run build` makes a mock one; see `spa-build.ts`).
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serveLocal, type ServeLocalOptions } from "@starkeep/app-client/local";
import { staticOptions } from "./client-routes.js";
import { app } from "./server.js";
import { buildStarkeepSpa, distRebuildReason } from "./spa-build.js";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = join(PKG_DIR, "dist");

/** Rebuilds `distDir` when it is not a current Starkeep build. */
export async function ensureStarkeepDist(distDir: string): Promise<void> {
  const rebuild = distRebuildReason(PKG_DIR, distDir);
  if (!rebuild) return;
  console.log(`exercise: dist/ is ${rebuild}, running \`vite build\` for the Starkeep backend…`);
  await buildStarkeepSpa({ root: PKG_DIR, build: { outDir: distDir, emptyOutDir: true } }, { marker: true });
}

/** What the local server serves: the Hono app, and the build in `distDir`. */
export function localServerOptions(distDir: string): Pick<ServeLocalOptions, "app" | "static"> {
  return { app, static: staticOptions(distDir) };
}

async function main(): Promise<void> {
  await ensureStarkeepDist(DIST_DIR);
  serveLocal({
    ...localServerOptions(DIST_DIR),
    onListen: ({ url }) => console.log(`exercise listening on ${url}`),
  });
}

// Only the CLI (`tsx starkeep/serve.ts`) starts a server; importing this module does not.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
