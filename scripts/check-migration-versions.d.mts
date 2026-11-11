// Types for check-migration-versions.mjs (AI-662). The script stays plain
// JavaScript because CI's migrate job and `npm run check-migrations` run it
// with node directly; this file lets scripts/**/*.test.ts be typechecked.

/** One version prefix shared by more than one migration file. */
export interface DuplicateVersion {
  /** The filename part before the first underscore, e.g. "20260906180000". */
  version: string;
  /** Every `.sql` filename in the directory with that prefix, sorted. */
  files: string[];
}

/**
 * Lists the version prefixes used by more than one `.sql` file in `dir`.
 * Returns an empty array when every prefix is unique.
 */
export function findDuplicateVersions(dir: string): DuplicateVersion[];
