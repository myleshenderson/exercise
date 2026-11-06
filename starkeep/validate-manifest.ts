/**
 * `npm run starkeep:validate`: validate starkeep.manifest.json with
 * `@starkeep/admin-manifest`'s `validateManifest`, the same check admin-web
 * runs at install. Exits non-zero on any error.
 */

import { validateManifest } from "@starkeep/admin-manifest";
import { readManifest } from "./manifest-file.js";

const result = validateManifest(readManifest());
for (const warning of result.warnings) console.warn(`warning: ${warning}`);
if (!result.valid) {
  for (const error of result.errors) console.error(`error: ${error}`);
  process.exit(1);
}
console.log("starkeep.manifest.json is valid.");
