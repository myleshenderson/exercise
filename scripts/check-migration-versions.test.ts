import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { findDuplicateVersions } from "./check-migration-versions.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "check-migration-versions.mjs");
const okFixture = join(here, "__fixtures__/migrations-ok");
const dupFixture = join(here, "__fixtures__/migrations-dup");

describe("findDuplicateVersions", () => {
  it("returns nothing when every migration has a unique version prefix", () => {
    expect(findDuplicateVersions(okFixture)).toEqual([]);
  });

  it("reports both filenames when two migrations share a version prefix", () => {
    expect(findDuplicateVersions(dupFixture)).toEqual([
      {
        version: "20260906180000",
        files: [
          "20260906180000_day_sequencing.sql",
          "20260906180000_exercises_soft_delete.sql",
        ],
      },
    ]);
  });
});

describe("check-migration-versions.mjs CLI", () => {
  it("exits 0 with no duplicates", () => {
    const output = execFileSync("node", [scriptPath, okFixture], {
      encoding: "utf8",
    });
    expect(output).toContain("No duplicate migration version prefixes found");
  });

  it("fails loudly, naming the colliding version and both filenames", () => {
    let error: unknown;
    try {
      execFileSync("node", [scriptPath, dupFixture], { encoding: "utf8" });
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    const { status, stderr } = error as { status: number; stderr: string };
    expect(status).toBe(1);
    expect(stderr).toContain("20260906180000");
    expect(stderr).toContain("20260906180000_day_sequencing.sql");
    expect(stderr).toContain("20260906180000_exercises_soft_delete.sql");
  });
});
