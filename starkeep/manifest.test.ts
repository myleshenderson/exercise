// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateManifest } from "@starkeep/admin-manifest";
import { readManifest } from "./manifest-file.js";
import { CLIENT_ROUTES, IMMUTABLE_PREFIX } from "./client-routes.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TABLE_NAMES = [
  // Strength (Supabase 0001 onward).
  "programs",
  "exercises",
  "workout_days",
  "workout_day_exercises",
  "workout_day_exercise_scheme_history",
  "sessions",
  "session_sets",
  // Ride analytics (supabase/migrations/20261111131256_ride_analytics.sql).
  "external_activities",
  "activity_streams",
  "body_weights",
  "athlete_settings",
  "ftp_history",
  "daily_training_load",
  "sync_state",
  "provider_credentials",
  // Starkeep-only.
  "mcp_tokens",
  "app_meta",
];

/**
 * The ride tables' deterministic ids (AI-822 decision 1). Starkeep keys every
 * row on `id` and its insert is a last-writer-wins upsert, so a re-synced
 * provider row lands on the same id instead of duplicating. `columns` are the
 * declared columns each id is built from.
 */
const RIDE_ID_SCHEME: Record<string, { scheme: string; columns: string[] }> = {
  external_activities: { scheme: "<source>:<source_id>", columns: ["source", "source_id"] },
  body_weights: { scheme: "<source>:<source_id>", columns: ["source", "source_id"] },
  activity_streams: { scheme: "<activity_id>:<channel>", columns: ["activity_id", "channel"] },
  ftp_history: { scheme: "<effective_from ISO>|<source>", columns: ["effective_from", "source"] },
  daily_training_load: { scheme: "<date YYYY-MM-DD>", columns: ["date"] },
  sync_state: { scheme: "<source>", columns: ["source"] },
  athlete_settings: { scheme: '"settings"', columns: [] },
  provider_credentials: { scheme: "<provider>", columns: ["provider"] },
};

/**
 * The manifest spelling of a react-router path: everything from the first
 * `:param` segment on becomes `/*`, e.g. `/session/:id/summary` → `/session/*`.
 */
function toManifestRoute(path: string): string {
  const segments = path.split("/");
  const firstParam = segments.findIndex((s) => s.startsWith(":"));
  return firstParam === -1 ? path : `${segments.slice(0, firstParam).join("/")}/*`;
}

describe("starkeep.manifest.json", () => {
  const result = validateManifest(readManifest());

  it("passes @starkeep/admin-manifest validateManifest with zero errors", () => {
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("declares the decided identity", () => {
    const m = result.manifest!;
    expect(m).toMatchObject({ id: "exercise", name: "Exercise", version: "0.1.0", tier: "community" });
    expect([...m.targets].sort()).toEqual(["cloud", "local"]);
    expect(m.infraRequirements.fileAccess).toEqual([]);
    expect(m.infraRequirements.labelKeys).toEqual([]);
    expect(m.infraRequirements.publicSharing).toBe(false);
  });

  it("declares exactly the 17 tables", () => {
    const tableNames = result.manifest!.infraRequirements.appSpecificSyncable.tables.map((t) => t.name);
    expect([...tableNames].sort()).toEqual([...TABLE_NAMES].sort());
  });

  it("keys every table on a text `id` and declares no auth-bound or reserved columns", () => {
    for (const table of result.manifest!.infraRequirements.appSpecificSyncable.tables) {
      const pk = table.columns.filter((c) => c.primaryKey);
      expect(pk.map((c) => [c.name, c.type, c.notNull]), table.name).toEqual([["id", "text", true]]);
      const names = table.columns.map((c) => c.name);
      expect(names, table.name).not.toContain("user_id");
      expect(names, table.name).not.toContain("updated_at");
      expect(names, table.name).not.toContain("deleted_at");
    }
    const tableNames = result.manifest!.infraRequirements.appSpecificSyncable.tables.map((t) => t.name);
    expect(tableNames).not.toContain("mcp_sessions");
    expect(tableNames).not.toContain("seed_claims");
  });

  it("declares a nullable app-owned `archived_at` timestamp on the soft-delete tables", () => {
    const tables = result.manifest!.infraRequirements.appSpecificSyncable.tables;
    for (const name of ["programs", "workout_days", "exercises"]) {
      const table = tables.find((t) => t.name === name);
      expect(table, name).toBeDefined();
      const col = table!.columns.find((c) => c.name === "archived_at");
      expect(col, `${name}.archived_at`).toBeDefined();
      expect(col!.type, `${name}.archived_at`).toBe("timestamp");
      expect(col!.notNull ?? false, `${name}.archived_at`).toBe(false);
      expect(col!.primaryKey ?? false, `${name}.archived_at`).toBe(false);
      // `deleted_at` is server-managed by the sync runtime; the app never declares it.
      expect(table!.columns.map((c) => c.name), name).not.toContain("deleted_at");
    }
  });

  it("declares the Starkeep-only `mcp_tokens` table", () => {
    const table = result.manifest!.infraRequirements.appSpecificSyncable.tables.find(
      (t) => t.name === "mcp_tokens",
    );
    expect(table).toBeDefined();
    const cols = table!.columns.map((c) => ({
      name: c.name,
      type: c.type,
      primaryKey: c.primaryKey ?? false,
      notNull: c.notNull ?? false,
    }));
    expect(cols).toEqual([
      { name: "id", type: "text", primaryKey: true, notNull: true },
      { name: "token_hash", type: "text", primaryKey: false, notNull: true },
      { name: "label", type: "text", primaryKey: false, notNull: false },
      { name: "created_at", type: "timestamp", primaryKey: false, notNull: true },
      { name: "last_used_at", type: "timestamp", primaryKey: false, notNull: false },
      { name: "expires_at", type: "timestamp", primaryKey: false, notNull: true },
    ]);
  });

  it("declares POST /mcp public on its own route and no static MCP token in env", () => {
    const shell = result.manifest!.infraRequirements.compute.handlers.find((h) => h.name === "static")!;
    expect(shell.routes).toContainEqual({ route: "POST /mcp", auth: "public" });
    expect(shell.env).not.toHaveProperty("STARKEEP_MCP_TOKEN");
    expect(JSON.stringify(result.manifest)).not.toContain("STARKEEP_MCP_TOKEN");
  });

  it("declares the platform's sign-in redirect target as a public client route", () => {
    // The cloud's CloudFront function sends a signed-out browser navigation to
    // /apps/exercise/sign-in. Undeclared, that path is behind the gateway's
    // session authorizer and answers {"message":"Unauthorized"} (AI-626).
    const shell = result.manifest!.infraRequirements.compute.handlers.find((h) => h.name === "static")!;
    expect(CLIENT_ROUTES).toContain("/sign-in");
    expect(shell.publicPaths).toContain("/sign-in");
  });

  it("serves exactly the SPA client routes and the immutable prefix from disk", () => {
    const shell = result.manifest!.infraRequirements.compute.handlers.find((h) => h.name === "static")!;
    expect([...shell.staticAssetPaths].sort()).toEqual([...CLIENT_ROUTES, IMMUTABLE_PREFIX].sort());
    for (const route of [...CLIENT_ROUTES, IMMUTABLE_PREFIX]) {
      expect(shell.publicPaths, route).toContain(route);
    }
  });

  it("lists every <Route path> in src/App.tsx as a client route", () => {
    const app = readFileSync(join(REPO_ROOT, "src", "App.tsx"), "utf8");
    // Every `<Route ...>` tag, wherever `path` sits among its attributes.
    const tags = [...app.matchAll(/<Route\b[^>]*>/g)].map((m) => m[0]);
    const paths = tags.map((tag) => /\spath="([^"]+)"/.exec(tag)?.[1]);
    // A Route without a literal path (`path={...}`, an index or layout route)
    // would escape the check below: fail instead, so the test gets taught.
    expect(paths.filter((p) => p === undefined), "<Route> without a literal path").toEqual([]);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(CLIENT_ROUTES as readonly string[], path).toContain(toManifestRoute(path!));
    }
  });

  it("declares the ride and strength indexes", () => {
    const tables = result.manifest!.infraRequirements.appSpecificSyncable.tables;
    const indexes = Object.fromEntries(tables.map((t) => [t.name, t.indexes.map((i) => i.columns)]));
    expect(indexes).toMatchObject({
      external_activities: [["started_at"], ["source", "started_at"], ["environment", "started_at"]],
      activity_streams: [["activity_id"]],
      body_weights: [["measured_at"]],
      ftp_history: [["effective_from"]],
      daily_training_load: [["date"]],
      workout_days: [["program_id"]],
      workout_day_exercises: [["workout_day_id"]],
      workout_day_exercise_scheme_history: [["workout_day_id", "exercise_id"]],
      sessions: [["performed_on"], ["workout_day_id"]],
      session_sets: [["session_id"], ["exercise_id"]],
    });
  });

  it("documents the ride id scheme in starkeep/README.md, built from declared columns", () => {
    // A literal `|` is escaped as `\|` inside a Markdown table cell.
    const readme = readFileSync(join(REPO_ROOT, "starkeep", "README.md"), "utf8").replaceAll("\\|", "|");
    const tables = result.manifest!.infraRequirements.appSpecificSyncable.tables;
    for (const [name, { scheme, columns }] of Object.entries(RIDE_ID_SCHEME)) {
      expect(readme, name).toContain(`\`${name}.id\` = \`${scheme}\``);
      const declared = tables.find((t) => t.name === name)!.columns.map((c) => c.name);
      for (const col of columns) expect(declared, `${name}.${col}`).toContain(col);
    }
  });

  it("keeps activity_streams' column named `values`, as a JSON-in-text array", () => {
    const table = result.manifest!.infraRequirements.appSpecificSyncable.tables.find(
      (t) => t.name === "activity_streams",
    )!;
    expect(table.columns.find((c) => c.name === "values")).toMatchObject({ type: "text", notNull: true });
  });
});
