#!/usr/bin/env node
// Detects migration files that share the same version prefix (the part of
// the filename before the first underscore). `supabase db push` records one
// applied migration per version, so a collision means one file silently
// never runs even though the push reports success. See exercise-kch.
import { readdirSync } from "node:fs";

export function findDuplicateVersions(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  const byVersion = new Map();
  for (const file of files) {
    const version = file.split("_")[0];
    if (!byVersion.has(version)) byVersion.set(version, []);
    byVersion.get(version).push(file);
  }
  return [...byVersion.entries()]
    .filter(([, filesForVersion]) => filesForVersion.length > 1)
    .map(([version, filesForVersion]) => ({
      version,
      files: filesForVersion.sort(),
    }));
}

function main() {
  const dir = process.argv[2] ?? "supabase/migrations";
  const duplicates = findDuplicateVersions(dir);

  if (duplicates.length === 0) {
    console.log(`No duplicate migration version prefixes found in ${dir}.`);
    return;
  }

  console.error("Duplicate migration version prefixes detected:\n");
  for (const { version, files } of duplicates) {
    console.error(`  version ${version} is used by:`);
    for (const file of files) console.error(`    - ${file}`);
    console.error("");
  }
  console.error(
    "supabase db push only records one applied migration per version, so one " +
      "of the files above would silently never run even though the push " +
      "reports success.",
  );
  console.error(
    "Rename one of the colliding files to a unique version (e.g. via " +
      "`supabase migration new <name>`) and try again.",
  );
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
