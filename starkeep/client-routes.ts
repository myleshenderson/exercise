/**
 * The SPA's client routes (the `<Route path>`s in `src/App.tsx`), in the
 * manifest's spelling: a literal path, or a `/prefix/*` glob.
 *
 * Read by `handler.ts`, which hands them to `createWebAppHandler` as
 * `shellPaths` so the cloud Lambda answers each with `index.html` from disk.
 * The manifest declares the same paths in the `static` handler's
 * `publicPaths` and `staticAssetPaths`; `manifest.test.ts` keeps the three in
 * agreement. Enumerated rather than `/*`, because a wildcard public path takes
 * the gateway's authorizer off the whole app.
 *
 * Locally `serve.ts` falls back to `index.html` for every non-server path, the
 * same as `vercel.json`'s rewrite.
 */
export const CLIENT_ROUTES = [
  "/",
  "/days",
  "/workouts",
  "/mcp-login",
  "/session/*",
  "/history/*",
] as const;

/** The content-hashed asset prefix (Vite `build.assetsDir`). */
export const IMMUTABLE_PREFIX = "/_immutable/*";
