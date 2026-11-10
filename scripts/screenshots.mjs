#!/usr/bin/env node
// Captures the README screenshots (docs/images/home.png, docs/images/mcp.png)
// and wires them into README.md. One-time setup: npx playwright install chromium
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDER_TIMEOUT_MS = 30_000;

const USAGE = `Usage: npm run screenshots -- [--base-url <url>] [--out-dir <dir>]

Starts the Vite dev server on a free port with the mock backend
(VITE_DATA_BACKEND unset), screenshots / and /mcp-login at 390x844, device
scale factor 2 (780x1688 PNGs), writes home.png and mcp.png to the output
directory, and replaces the README placeholders with the image tags.

  --base-url <url>  Screenshot this running app instead of starting a dev server.
  --out-dir <dir>   Where to write the PNGs (default: docs/images).
  --help            Show this message.

One-time setup: npx playwright install chromium`;

const SHOTS = [
  {
    name: "home",
    route: "/",
    // A day card: the seeded day templates have loaded, not just the heading.
    selector: "button.rounded-xl",
    alt: "Home screen with today's planned workout",
  },
  {
    name: "mcp",
    route: "/mcp-login",
    selector: "textarea#mcp-cli-snippet",
    alt: "MCP screen for creating a connector token",
  },
];

function parseArgs(argv) {
  const opts = { baseUrl: null, outDir: "docs/images", help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--base-url" || arg === "--out-dir") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) fail(`${arg} needs a value.\n\n${USAGE}`);
      if (arg === "--base-url") opts.baseUrl = value;
      else opts.outDir = value;
    } else fail(`Unknown argument: ${arg}\n\n${USAGE}`);
  }
  return opts;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startDevServer() {
  const port = await freePort();
  const env = { ...process.env };
  delete env.VITE_DATA_BACKEND; // mock backend, seeded data, no sign-in
  const vite = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [vite, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Vite did not start within 60s:\n${output}`)), 60_000);
    const onData = (chunk) => {
      output += chunk;
      if (output.includes(`:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Vite exited with code ${code}:\n${output}`));
    });
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill("SIGTERM") };
}

async function updateReadme(relOutDir) {
  const readmePath = path.join(ROOT, "README.md");
  let readme = await readFile(readmePath, "utf8");
  for (const { name, alt } of SHOTS) {
    const src = path.posix.join(relOutDir.split(path.sep).join("/"), `${name}.png`);
    const tag = `<img src="${src}" alt="${alt}" width="320">`;
    readme = readme.replace(`<!-- screenshot: ${name} -->`, tag);
  }
  await writeFile(readmePath, readme);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    fail("Playwright is not installed. Run npm install, then npx playwright install chromium.");
  }
  const outDir = path.resolve(ROOT, opts.outDir);
  await mkdir(outDir, { recursive: true });

  const server = opts.baseUrl ? null : await startDevServer();
  const baseUrl = (opts.baseUrl ?? server.url).replace(/\/+$/, "");
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    for (const shot of SHOTS) {
      await page.goto(`${baseUrl}${shot.route}`);
      try {
        await page.waitForSelector(shot.selector, { state: "visible", timeout: RENDER_TIMEOUT_MS });
      } catch {
        throw new Error(`${baseUrl}${shot.route} never rendered (no "${shot.selector}" after ${RENDER_TIMEOUT_MS / 1000}s).`);
      }
      const file = path.join(outDir, `${shot.name}.png`);
      await page.screenshot({ path: file });
      console.log(`Wrote ${path.relative(ROOT, file)}`);
    }
  } finally {
    await browser?.close();
    server?.stop();
  }
  await updateReadme(path.relative(ROOT, outDir));
  console.log("README.md image tags are in place.");
}

main().catch((err) => fail(`screenshots: ${err.message}`));
