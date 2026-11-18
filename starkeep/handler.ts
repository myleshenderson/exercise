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
import { staticOptions } from "./client-routes.js";

export const handler = await createWebAppHandler({
  basePath: process.env.STARKEEP_APP_BASE_PATH || `/apps/${manifest.id}`,
  ...staticOptions(new URL("./assets/", import.meta.url)),
  requestUpstream: import("./server.js").then((m) => ({ handler: honoUpstream(m.app) })),
  onError: (err) => ({
    statusCode: 500,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: `exercise static handler: ${String(err)}` }),
  }),
});
