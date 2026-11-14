/**
 * The SPA's client routes (the `<Route path>`s in `src/App.tsx`), in the
 * manifest's spelling: a literal path, or a `/prefix/*` glob.
 *
 * Read by `handler.ts`, which hands them to `createWebAppHandler` as
 * `shellPaths` so the cloud Lambda answers each with `index.html` from disk.
 * The manifest declares the same paths in the `static` handler's
 * `publicPaths` and `staticAssetPaths`; `manifest.test.ts` keeps the three in
 * agreement and checks that every `<Route path>` in `src/App.tsx` is covered
 * here, so a new screen cannot be forgotten. Enumerated rather than `/*`,
 * because a wildcard public path takes the gateway's authorizer off the whole
 * app.
 *
 * Locally `serve.ts` falls back to `index.html` for every non-server path, the
 * same as `vercel.json`'s rewrite.
 */
export const CLIENT_ROUTES = [
  "/",
  // Where the cloud's CloudFront function sends a signed-out browser navigation.
  // It must be public and served, or the redirect ends in the gateway's 401.
  "/sign-in",
  "/days",
  "/workouts",
  "/mcp-login",
  "/session/*",
  "/history/*",
  // Ride analytics screens (AI-627 wave 3).
  "/activities",
  "/activities/*",
  "/stats",
  "/training",
  "/power",
  "/weight",
  "/settings",
] as const;

/** The content-hashed asset prefix (Vite `build.assetsDir`). */
export const IMMUTABLE_PREFIX = "/_immutable/*";
