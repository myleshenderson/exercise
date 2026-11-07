import type { Transport } from "./rows";

/**
 * The browser's route to the data plane: the app server's same-origin signing
 * proxy, mounted at `api/local-data/` under Vite's `base` (starkeep/server.ts,
 * starkeep/README.md "Browser data proxy"). A data-server path such as
 * `/app-data/db/programs?where=…` becomes
 * `${BASE_URL}api/local-data/app-data/db/programs?where=…`.
 *
 * `BASE_URL` is `/` on Vercel and a local Starkeep install, `/apps/exercise/`
 * in the cloud bundle. A bare `/api/local-data` would escape the cloud mount.
 * Read at call time so tests can `vi.stubEnv("BASE_URL", …)`.
 */
export function localDataUrl(path: string): string {
  const raw = import.meta.env.BASE_URL || "/";
  const base = raw.endsWith("/") ? raw : `${raw}/`;
  return `${base}api/local-data/${path.replace(/^\/+/, "")}`;
}

export const browserTransport: Transport = (path, init) =>
  fetch(localDataUrl(path), { ...init, credentials: "include" });
