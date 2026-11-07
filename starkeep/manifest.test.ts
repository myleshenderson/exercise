// @vitest-environment node
import { describe, expect, it } from "vitest";
import { validateManifest } from "@starkeep/admin-manifest";
import { readManifest } from "./manifest-file.js";
import { CLIENT_ROUTES, IMMUTABLE_PREFIX } from "./client-routes.js";

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

  it("keys every table on a text `id` and declares no auth-bound or reserved columns", () => {
    for (const table of result.manifest!.infraRequirements.appSpecificSyncable.tables) {
      const pk = table.columns.filter((c) => c.primaryKey);
      expect(pk.map((c) => [c.name, c.type]), table.name).toEqual([["id", "text"]]);
      const names = table.columns.map((c) => c.name);
      expect(names, table.name).not.toContain("user_id");
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

  it("declares POST /mcp public on its own route and STARKEEP_MCP_TOKEN in env", () => {
    const shell = result.manifest!.infraRequirements.compute.handlers.find((h) => h.name === "static")!;
    expect(shell.routes).toContainEqual({ route: "POST /mcp", auth: "public" });
    expect(shell.env).toHaveProperty("STARKEEP_MCP_TOKEN");
  });

  it("serves exactly the SPA client routes and the immutable prefix from disk", () => {
    const shell = result.manifest!.infraRequirements.compute.handlers.find((h) => h.name === "static")!;
    expect([...shell.staticAssetPaths].sort()).toEqual([...CLIENT_ROUTES, IMMUTABLE_PREFIX].sort());
  });
});
