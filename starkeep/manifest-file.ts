import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "starkeep.manifest.json");

/** The raw manifest JSON, unvalidated. */
export function readManifest(): unknown {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}
