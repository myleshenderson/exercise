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
