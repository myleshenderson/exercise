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
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { app, isServerPath } from "./server.js";
import { buildStarkeepSpa, distRebuildReason } from "./spa-build.js";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = join(PKG_DIR, "dist");
const SHELL = join(DIST_DIR, "index.html");

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

/** A file under `dist/` for this path, or the shell. Never escapes `dist/`. */
function resolveClientFile(pathname: string): { file: string; asset: boolean } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { file: SHELL, asset: false };
  }
  const candidate = join(DIST_DIR, normalize(decoded));
  if (candidate.startsWith(DIST_DIR + sep) && isFile(candidate)) return { file: candidate, asset: true };
  return { file: SHELL, asset: false };
}

const LISTEN_HOST = "127.0.0.1";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return true;
  const lower = host.trim().toLowerCase();
  const end = lower.startsWith("[") ? lower.indexOf("]") + 1 : lower.indexOf(":");
  return LOOPBACK_HOSTNAMES.has(end > 0 ? lower.slice(0, end) : lower);
}

function portFromArgv(argv: string[]): number {
  const at = argv.findIndex((a) => a === "--port" || a === "-p");
  const value = at >= 0 ? Number(argv[at + 1]) : Number(process.env.PORT);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("exercise needs a port: -p <n> (admin-web passes it via the manifest portFlag)");
  }
  return value;
}

async function main(): Promise<void> {
  const port = portFromArgv(process.argv.slice(2));

  const rebuild = distRebuildReason(PKG_DIR, DIST_DIR);
  if (rebuild) {
    console.log(`exercise: dist/ is ${rebuild}, running \`vite build\` for the Starkeep backend…`);
    await buildStarkeepSpa({ root: PKG_DIR }, { marker: true });
  }

  const api = getRequestListener(app.fetch);
  const client = getRequestListener(async (request) => {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const { file, asset } = resolveClientFile(new URL(request.url).pathname);
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

  server.listen(port, LISTEN_HOST, () => {
    console.log(`exercise listening on http://localhost:${port}`);
  });
}

void main();
