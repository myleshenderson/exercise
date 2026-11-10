/**
 * Exercise's local Starkeep surface: `@hono/node-server` in front of the same
 * Hono app the Lambda runs, with the built SPA (`dist/`) beside it.
 *
 * admin-web starts this from the manifest's `localRun`:
 *
 *     npm run starkeep:serve -- -p <port>
 *
 * `-p`/`--port` is the manifest `portFlag`; `PORT` is the fallback for a
 * person running it by hand.
 *
 * Shape copied from photos' `src/serve.ts`: loopback-only bind plus a `Host`
 * check against DNS rebinding, and a self-healing `vite build` when `dist/` is
 * missing, older than its sources, or not a Starkeep-backend build (a plain
 * `npm run build` makes a mock one; see `spa-build.ts`). The client half answers a real file from
 * `dist/` when one exists and `index.html` for every other path, which is
 * the same fallback `vercel.json`'s rewrite gives.
 */

import { createServer } from "node:http";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { app, isServerPath } from "./server.js";
import { buildStarkeepSpa, distRebuildReason } from "./spa-build.js";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = join(PKG_DIR, "dist");

const MIME: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    // e.g. a NUL byte from `%00` in the URL: not a file, so the shell answers.
    return false;
  }
}

/** A file under `distDir` for this path, or the shell. Never escapes `distDir`. */
function resolveClientFile(distDir: string, pathname: string): { file: string; asset: boolean } {
  const shell = join(distDir, "index.html");
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { file: shell, asset: false };
  }
  const candidate = join(distDir, normalize(decoded));
  if (candidate.startsWith(distDir + sep) && isFile(candidate)) return { file: candidate, asset: true };
  return { file: shell, asset: false };
}

const LISTEN_HOST = "127.0.0.1";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return true;
  const lower = host.trim().toLowerCase();
  const end = lower.startsWith("[") ? lower.indexOf("]") + 1 : lower.indexOf(":");
  return LOOPBACK_HOSTNAMES.has(end > 0 ? lower.slice(0, end) : lower);
}

export function portFromArgv(argv: string[]): number {
  const at = argv.findIndex((a) => a === "--port" || a === "-p");
  const value = at >= 0 ? Number(argv[at + 1]) : Number(process.env.PORT);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("exercise needs a port: -p <n> (admin-web passes it via the manifest portFlag)");
  }
  return value;
}

/**
 * Start the local surface on `127.0.0.1:<port>` serving the SPA from
 * `distDir` (rebuilt first when stale). `port: 0` picks a free port; the
 * returned `port` is the one actually bound. `close()` resolves once the
 * listener has closed.
 */
export async function startServer(opts: {
  distDir: string;
  port: number;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const { distDir } = opts;

  const rebuild = distRebuildReason(PKG_DIR, distDir);
  if (rebuild) {
    console.log(`exercise: dist/ is ${rebuild}, running \`vite build\` for the Starkeep backend…`);
    await buildStarkeepSpa({ root: PKG_DIR, build: { outDir: distDir, emptyOutDir: true } }, { marker: true });
  }

  const api = getRequestListener(app.fetch);
  const client = getRequestListener(async (request) => {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const { file, asset } = resolveClientFile(distDir, new URL(request.url).pathname);
    const contentType = asset
      ? (MIME[file.slice(file.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream")
      : "text/html; charset=utf-8";
    return new Response(await readFile(file), {
      headers: { "content-type": contentType, "cache-control": "no-cache" },
    });
  });

  const server = createServer((req, res) => {
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Exercise answers on its loopback address only" }));
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (isServerPath(pathname)) void api(req, res);
    else void client(req, res);
  });

  const port = await new Promise<number>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(opts.port, LISTEN_HOST, () => {
      server.off("error", rejectListen);
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : opts.port;
      console.log(`exercise listening on http://localhost:${bound}`);
      resolveListen(bound);
    });
  });

  return {
    port,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
        // Keep-alive sockets would otherwise hold close() open until they time out.
        server.closeIdleConnections();
      }),
  };
}

async function main(): Promise<void> {
  await startServer({ distDir: DIST_DIR, port: portFromArgv(process.argv.slice(2)) });
}

// Only the CLI (`tsx starkeep/serve.ts`) starts a server; importing this module does not.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
