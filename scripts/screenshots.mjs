#!/usr/bin/env node
// Captures the README screenshots (docs/images/<name>.png, one per entry in
// SHOTS) and wires them into README.md. With --rides, captures the ride
// analytics screens (RIDE_SHOTS) from synthetic fixtures into --out-dir
// instead, and leaves README.md alone. One-time setup: npx playwright install chromium
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDER_TIMEOUT_MS = 30_000;
const DEFAULT_WIDTH = 320; // README display width in CSS px; the PNGs are 780 wide
const GALLERY_WIDTH = 180;

const USAGE = `Usage: npm run screenshots -- [--base-url <url>] [--out-dir <dir>]
       npm run screenshots -- --rides --out-dir <dir> [--only a,b] [--base-url <url>]

Starts the Vite dev server on a free port with the mock backend
(VITE_DATA_BACKEND unset), screenshots every main screen at 390x844, device
scale factor 2 (780x1688 PNGs), writes one PNG per screen to the output
directory, and replaces the README placeholders with the image tags.

Screens: home (/), mcp (/mcp-login), session (/session/seed-upper), summary
(/session/seed-upper/summary), days (/days), workouts (/workouts) and history
(/history/leg-press). The ids are the mock backend's seeded data, so they are
stable without any clicking.

  --base-url <url>  Screenshot this running app instead of starting a dev server.
  --out-dir <dir>   Where to write the PNGs (default: docs/images; required with --rides).
  --rides           Ride analytics stills instead: starts Vite with VITE_MOCK_RIDES=1
                    (synthetic ride fixtures), shoots each RIDE_SHOTS entry once its
                    [data-ready="<name>"] element is visible, and never edits README.md.
                    With --base-url, that app must already run with VITE_MOCK_RIDES=1.
  --only a,b        With --rides: only these shots. Names (routes): home-strip (/),
                    activities, activity-outdoor (/activities/ride-outdoor-1),
                    activity-indoor (/activities/ride-indoor-1), stats-cycling (/stats),
                    stats-strength (/stats?tab=strength), training, power, weight, settings.
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
  // The rest are the "Screens" gallery in the README, shown smaller.
  {
    name: "session",
    // The seeded Upper Day session: four exercises logged, two still open.
    route: "/session/seed-upper",
    selector: "button:has-text('Finish workout')",
    alt: "Session screen with logged and remaining exercises",
    width: GALLERY_WIDTH,
  },
  {
    name: "summary",
    route: "/session/seed-upper/summary",
    selector: "h1:has-text('complete')",
    alt: "Summary screen after finishing a workout",
    width: GALLERY_WIDTH,
  },
  {
    name: "days",
    route: "/days",
    // A day card has rendered, not just the heading.
    selector: "h2:has-text('Leg Day')",
    alt: "Manage Schedule screen with day templates and their exercises",
    width: GALLERY_WIDTH,
  },
  {
    name: "workouts",
    route: "/workouts",
    selector: "li",
    alt: "Logged Workouts screen listing past sessions",
    width: GALLERY_WIDTH,
  },
  {
    name: "history",
    route: "/history/leg-press",
    selector: "h1:has-text('Leg Press')",
    alt: "History screen with past sets for one exercise",
    width: GALLERY_WIDTH,
  },
];

// Ride analytics stills (AI-649). Each screen root sets data-ready="<name>" once
// its data has loaded; the ids are the ride fixtures' (src/rides/testing/fixtures.ts).
export const RIDE_SHOTS = [
  { name: "home-strip", route: "/" },
  { name: "activities", route: "/activities" },
  { name: "activity-outdoor", route: "/activities/ride-outdoor-1" },
  { name: "activity-indoor", route: "/activities/ride-indoor-1" },
  { name: "stats-cycling", route: "/stats" },
  { name: "stats-strength", route: "/stats?tab=strength" },
  { name: "training", route: "/training" },
  { name: "power", route: "/power" },
  { name: "weight", route: "/weight" },
  { name: "settings", route: "/settings" },
];
const RIDE_SHOT_NAMES = RIDE_SHOTS.map((s) => s.name).join(", ");

export function parseArgs(argv) {
  const opts = { baseUrl: null, outDir: null, help: false, rides: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--rides") opts.rides = true;
    else if (arg === "--base-url" || arg === "--out-dir" || arg === "--only") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) fail(`${arg} needs a value.\n\n${USAGE}`);
      if (arg === "--base-url") opts.baseUrl = value;
      else if (arg === "--out-dir") opts.outDir = value;
      else opts.only = value.split(",").map((n) => n.trim()).filter(Boolean);
    } else fail(`Unknown argument: ${arg}\n\n${USAGE}`);
  }
  if (opts.help) return opts;
  if (opts.rides) {
    if (!opts.outDir) fail(`--rides needs --out-dir (ride stills never go to docs/images).\n\n${USAGE}`);
    if (opts.only) {
      if (opts.only.length === 0) fail(`--only needs at least one shot name. Known: ${RIDE_SHOT_NAMES}.`);
      const unknown = opts.only.filter((n) => !RIDE_SHOTS.some((s) => s.name === n));
      if (unknown.length) fail(`Unknown ride shot(s): ${unknown.join(", ")}. Known: ${RIDE_SHOT_NAMES}.`);
    }
  } else {
    if (opts.only) fail(`--only works with --rides only.\n\n${USAGE}`);
    opts.outDir ??= "docs/images";
  }
  return opts;
}

/** The shots to take for parsed options: SHOTS, or RIDE_SHOTS filtered by --only (in RIDE_SHOTS order). */
export function shotsFor(opts) {
  if (!opts.rides) return SHOTS;
  return opts.only ? RIDE_SHOTS.filter((s) => opts.only.includes(s.name)) : RIDE_SHOTS;
}

export function fail(message) {
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

async function startDevServer({ rides = false } = {}) {
  const port = await freePort();
  const env = { ...process.env };
  delete env.VITE_DATA_BACKEND; // mock backend, seeded data, no sign-in
  if (rides) env.VITE_MOCK_RIDES = "1"; // preload the synthetic ride fixtures
  else delete env.VITE_MOCK_RIDES;
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
  for (const { name, alt, width = DEFAULT_WIDTH } of SHOTS) {
    const src = path.posix.join(relOutDir.split(path.sep).join("/"), `${name}.png`);
    const tag = `<img src="${src}" alt="${alt}" width="${width}">`;
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
  const shots = shotsFor(opts);

  const server = opts.baseUrl ? null : await startDevServer({ rides: opts.rides });
  const baseUrl = (opts.baseUrl ?? server.url).replace(/\/+$/, "");
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    for (const shot of shots) {
      const selector = opts.rides ? `[data-ready="${shot.name}"]` : shot.selector;
      await page.goto(`${baseUrl}${shot.route}`);
      try {
        await page.waitForSelector(selector, { state: "visible", timeout: RENDER_TIMEOUT_MS });
      } catch {
        throw new Error(`${baseUrl}${shot.route} never rendered (no "${selector}" after ${RENDER_TIMEOUT_MS / 1000}s).`);
      }
      const file = path.join(outDir, `${shot.name}.png`);
      await page.screenshot({ path: file });
      console.log(`Wrote ${path.relative(ROOT, file)}`);
    }
  } finally {
    await browser?.close();
    server?.stop();
  }
  if (opts.rides) return; // ride stills are review artefacts; README.md is never touched
  await updateReadme(path.relative(ROOT, outDir));
  console.log("README.md image tags are in place.");
}

// Run only as a script, so tests can import parseArgs, shotsFor and RIDE_SHOTS.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => fail(`screenshots: ${err.message}`));
}
