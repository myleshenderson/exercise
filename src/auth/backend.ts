/**
 * Which backend this build talks to, and where the app is mounted.
 *
 * Kept apart from `src/data/index.ts` on purpose: the auth screens decide
 * between Supabase and Starkeep sign-in from here, without importing the
 * DataLayer (and, through it, supabase-js).
 *
 * Everything reads `import.meta.env` at call time, not at module load, so a
 * test can `vi.stubEnv` it.
 */

/** The Starkeep app id (`starkeep.manifest.json` `id`). Cookies and sign-in are scoped to it. */
export const STARKEEP_APP_ID = "exercise";

export function isStarkeepBackend(): boolean {
  return import.meta.env.VITE_DATA_BACKEND === "starkeep";
}

/**
 * Vite's `base`, always with a trailing slash: `/` on Vercel and on a local
 * Starkeep install, `/apps/exercise/` in a Starkeep cloud install (set by
 * `npm run bundle`).
 */
export function baseUrl(): string {
  const base = import.meta.env.BASE_URL || "/";
  return base.endsWith("/") ? base : `${base}/`;
}

/**
 * The same-origin address of an app path such as `api/mcp-login`, under the
 * mount. Vite's `base` rewrites asset URLs only; a raw `fetch("/api/...")`
 * would escape `/apps/exercise/` in the cloud.
 */
export function appPath(path: string): string {
  return `${baseUrl()}${path.replace(/^\/+/, "")}`;
}

/** `BrowserRouter`'s `basename`: the base with the trailing slash trimmed (`/` stays `/`). */
export function routerBasename(): string {
  return baseUrl().replace(/\/+$/, "") || "/";
}

