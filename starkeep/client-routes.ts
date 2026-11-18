import type { ServeLocalOptions } from "@starkeep/app-client/local";
import manifest from "../starkeep.manifest.json" with { type: "json" };

/**
 * The SPA's client routes (the `<Route path>`s in `src/App.tsx`), in the
 * manifest's spelling: a literal path, or a `/prefix/*` glob.
 *
 * `staticOptions` hands them to the platform's static responder as
 * `shellPaths`, so both surfaces answer each with `index.html` from disk: the
 * cloud Lambda (`handler.ts`) and the local server (`serve.ts`). The manifest
 * declares the same paths in the `static` handler's `publicPaths` and
 * `staticAssetPaths`; `manifest.test.ts` keeps the three in agreement and
 * checks that every `<Route path>` in `src/App.tsx` is covered here, so a new
 * screen cannot be forgotten. Enumerated rather than `/*`, because a wildcard
 * public path takes the gateway's authorizer off the whole app.
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

/** Vite's `build.assetsDir` for every Starkeep build (`spa-build.ts`): the content-hashed files. */
export const IMMUTABLE_ASSETS_DIR = "_immutable";

/** The content-hashed asset prefix, in the manifest's spelling. */
export const IMMUTABLE_PREFIX = `/${IMMUTABLE_ASSETS_DIR}/*`;

/**
 * The static responder's options for a Starkeep build in `assetsDir`, shared
 * by the cloud Lambda (`handler.ts`) and the local server (`serve.ts`), so the
 * two surfaces answer the same paths from disk with the same rules.
 */
export function staticOptions(assetsDir: string | URL): NonNullable<ServeLocalOptions["static"]> {
  const shell = manifest.infraRequirements.compute.handlers.find((h) => h.name === "static");
  if (!shell) throw new Error("exercise manifest has no `static` compute handler");
  const clientRoutes: readonly string[] = CLIENT_ROUTES;
  return {
    assetsDir,
    // The manifest's `staticAssetPaths` is everything answered from disk ahead
    // of the app; the responder wants the shell routes separately.
    staticPaths: shell.staticAssetPaths.filter((p) => !clientRoutes.includes(p)),
    shellPaths: [...CLIENT_ROUTES],
    immutablePaths: [IMMUTABLE_PREFIX],
    staticMiss: "notFound",
  };
}
