/**
 * The `static` cloud handler: the single Lambda behind `/apps/exercise`.
 *
 * Bundled by `build-bundle.ts` to `index.mjs` at the zip root, which is what
 * the manifest's `"handler": "index.handler"` resolves. Copies the shape of
 * photos' `src/static-handler.ts`:
 *
 *   - content-hashed assets under `/_immutable/*` are files in `assets/`;
 *   - the SPA's client routes are answered with `assets/index.html`;
 *   - everything else (`/mcp`, the runtime config, the session routes) goes to
 *     the Hono app.
 *
 * `createWebAppHandler` awaits the app's module graph at module scope, so it
 * loads during Lambda INIT rather than in the first billed request.
 */

import { createWebAppHandler } from "@starkeep/app-client/web";
import { honoUpstream } from "@starkeep/app-client/hono";
import manifest from "../starkeep.manifest.json" with { type: "json" };
import { CLIENT_ROUTES, IMMUTABLE_PREFIX } from "./client-routes.js";

const shell = manifest.infraRequirements.compute.handlers.find((h) => h.name === "static");
if (!shell) throw new Error("exercise manifest has no `static` compute handler");

const clientRoutes: readonly string[] = CLIENT_ROUTES;

// The manifest's `staticAssetPaths` is everything answered from disk ahead of
// the app; the adapter wants the shell routes separately.
const staticPaths = shell.staticAssetPaths.filter((p) => !clientRoutes.includes(p));

export const handler = await createWebAppHandler({
  basePath: process.env.STARKEEP_APP_BASE_PATH || `/apps/${manifest.id}`,
  assetsDir: new URL("./assets/", import.meta.url),
  staticPaths,
  shellPaths: [...clientRoutes],
  immutablePaths: [IMMUTABLE_PREFIX],
  staticMiss: "notFound",
  requestUpstream: import("./server.js").then((m) => ({ handler: honoUpstream(m.app) })),
  onError: (err) => ({
    statusCode: 500,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: `exercise static handler: ${String(err)}` }),
  }),
});
