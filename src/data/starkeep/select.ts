/**
 * Bounded multi-id reads over the row API, shared by the Starkeep DataLayer
 * (`../starkeep.ts`, `./rideAnalytics.ts`) and `starkeep/handlers.ts`.
 */
import type { Row, RowClient, Where } from "./rows.js";

/** Ids per `in` filter, to keep each query string well under URL limits. */
export const IN_CHUNK = 100;

export function chunks<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * selectAll with `column in ids`, chunked to {@link IN_CHUNK} ids per request;
 * rows from every chunk, in chunk order, otherwise unsorted. Null/undefined ids
 * and duplicates are dropped, and no ids means no request at all.
 */
export async function selectIn<R extends Row>(
  rows: RowClient,
  table: string,
  column: string,
  ids: readonly (string | null | undefined)[],
  opts: { where?: Where; select?: string[]; order?: string[] } = {},
): Promise<R[]> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  const out: R[] = [];
  for (const part of chunks(unique)) {
    out.push(...(await rows.selectAll<R>(table, { ...opts, where: { ...opts.where, [column]: { in: part } } })));
  }
  return out;
}
