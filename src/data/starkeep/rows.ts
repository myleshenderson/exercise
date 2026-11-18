/**
 * A transport-agnostic client for Starkeep's app-table row API
 * (`/app-data/db/<table>`, starkeep-core authoring guide §6a).
 *
 * The client builds data-server paths (`/app-data/db/<table>?<query>`) and
 * hands them to a {@link Transport}. The browser transport prefixes them with
 * the app's same-origin signing proxy; a server-side transport (the MCP
 * handlers) can hand the same path to `signedFetch`. Nothing here knows which.
 *
 * Grammar, as the data server parses it:
 * - `where`: strict JSON. A column maps to a scalar (equality) or to an object
 *   of operators: lt, lte, gt, gte, ne, in, is, prefix, like. AND only; no OR.
 * - `select`: comma-separated columns. Omitted means every column.
 * - `order`: `col.asc` / `col.desc`, optionally `.nullsfirst` / `.nullslast`
 *   (nulls sort last unless stated). The server appends the primary key.
 * - `limit`: default 30, maximum 500.
 * - `page_token`: opaque; resend with the same where/order to get the next page.
 * - `aggregate`: strict JSON; `select` becomes the GROUP BY list.
 *
 * Responses: `{rows, truncated, page_token}` or `{groups, truncated}`. Writes:
 * `POST {row, ifAbsent?}` → `{ok, changes, skipped?}`, `PATCH {where, patch}`
 * → `{changes}`, `DELETE {where}` → `{changes, skipped?}`. Errors are a
 * non-2xx status with `{error}`.
 *
 * Write rules, as the data server enforces them (guide §6b):
 * - A `PATCH` or `DELETE` `where` names the whole primary key, each column as
 *   a plain value. Exercise's tables all key on `id`, so a write names one row
 *   by its `id`; to write several, select their ids and write each.
 * - A `PATCH` or `DELETE` of a key no live row holds answers 404 with
 *   `skipped: "missing"`. The client returns that as a result
 *   (`{ changes: 0, skipped: "missing" }`), not an error, because it is an
 *   expected answer, as an update matching no row is in Postgres. Any other
 *   404 still throws.
 * - An `ifAbsent` insert of a key some row already holds, live or deleted,
 *   writes nothing and answers `skipped: "live"` or `"deleted"`.
 */

export type Transport = (path: string, init: RequestInit) => Promise<Response>;

export type Scalar = string | number | boolean | null;

export interface WhereOps {
  /** Equality. Sent as the bare scalar, which is how the grammar spells it. */
  eq?: Exclude<Scalar, null>;
  lt?: string | number;
  lte?: string | number;
  gt?: string | number;
  gte?: string | number;
  ne?: Exclude<Scalar, null>;
  in?: Exclude<Scalar, null>[];
  is?: null | true | false;
  prefix?: string;
  like?: string;
}

/** Column → scalar (equality; `null` means `is null`) or operator object. AND-joined. */
export type Where = Record<string, Scalar | WhereOps>;

export type Row = Record<string, unknown>;

export interface SelectOptions {
  where?: Where;
  /** Columns to return; omitted means every column. */
  select?: string[];
  /** Order terms such as `"position.asc"` or `"performed_on.desc"`. */
  order?: string[];
  limit?: number;
  pageToken?: string;
}

export interface SelectResult<T extends Row = Row> {
  rows: T[];
  truncated: boolean;
  pageToken: string | null;
}

export type AggregateFn =
  | { fn: "count"; col?: string; distinct?: string }
  | { fn: "sum" | "avg" | "min" | "max"; col: string };

export interface AggregateOptions {
  where?: Where;
  /** The GROUP BY list (sent as `select`). */
  groupBy?: string[];
  /** Output column name → aggregate function. */
  aggregate: Record<string, AggregateFn>;
  order?: string[];
  limit?: number;
}

export interface AggregateResult<T extends Row = Row> {
  groups: T[];
  truncated: boolean;
}

/** The row API's maximum page size. */
export const MAX_PAGE = 500;

export class RowApiError extends Error {
  readonly status: number;
  readonly table: string;
  constructor(table: string, status: number, message: string) {
    super(`Starkeep row API ${status} on ${table}: ${message}`);
    this.name = "RowApiError";
    this.status = status;
    this.table = table;
  }
}

/** Why a write changed nothing, as the data server reports it. */
export type WriteSkip = "live" | "deleted" | "missing";

/** What one row write did. */
export interface WriteResult {
  changes: number;
  skipped?: WriteSkip;
}

export interface InsertOptions {
  /** Write only when no row, live or deleted, holds the key. */
  ifAbsent?: boolean;
}

export interface RowClient {
  select<T extends Row = Row>(table: string, opts?: SelectOptions): Promise<SelectResult<T>>;
  /** Every matching row: follows `page_token` (at {@link MAX_PAGE} rows a page) until exhausted. */
  selectAll<T extends Row = Row>(table: string, opts?: Omit<SelectOptions, "limit" | "pageToken">): Promise<T[]>;
  aggregate<T extends Row = Row>(table: string, opts: AggregateOptions): Promise<AggregateResult<T>>;
  insert(table: string, row: Row, opts?: InsertOptions): Promise<WriteResult>;
  /** `where` names the whole primary key; `skipped: "missing"` when no live row holds it. */
  patch(table: string, where: Where, patch: Row): Promise<WriteResult>;
  /** `where` names the whole primary key; `skipped` when the row is already deleted or never existed. */
  remove(table: string, where: Where): Promise<WriteResult>;
}

/** Normalise a `Where` to the wire form: `{eq: v}` → `v`, bare `null` → `{is: null}`. */
export function encodeWhere(where: Where): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [column, cond] of Object.entries(where)) {
    if (cond === null) {
      out[column] = { is: null };
    } else if (typeof cond !== "object") {
      out[column] = cond;
    } else {
      const { eq, ...rest } = cond;
      const ops = Object.entries(rest).filter(([, v]) => v !== undefined);
      if (eq !== undefined && ops.length === 0) {
        out[column] = eq;
      } else if (eq !== undefined) {
        // Equality plus other operators on one column cannot be spelled in one
        // key; equality subsumes them anyway, so keep the strictest meaning by
        // refusing rather than silently dropping one.
        throw new Error(`where["${column}"] combines eq with other operators; use eq alone`);
      } else {
        out[column] = Object.fromEntries(ops);
      }
    }
  }
  return out;
}

export function tablePath(table: string): string {
  return `/app-data/db/${encodeURIComponent(table)}`;
}

/** The query string (without `?`) for a select or aggregate request. */
export function buildQuery(opts: SelectOptions & { aggregate?: Record<string, AggregateFn> }): string {
  const params = new URLSearchParams();
  if (opts.where && Object.keys(opts.where).length > 0) params.set("where", JSON.stringify(encodeWhere(opts.where)));
  if (opts.select && opts.select.length > 0) params.set("select", opts.select.join(","));
  if (opts.aggregate) params.set("aggregate", JSON.stringify(opts.aggregate));
  if (opts.order && opts.order.length > 0) params.set("order", opts.order.join(","));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.pageToken !== undefined) params.set("page_token", opts.pageToken);
  return params.toString();
}

const JSON_HEADERS = { "content-type": "application/json" };

const SKIPS: readonly string[] = ["live", "deleted", "missing"];

function writeResult(body: unknown): WriteResult {
  const { changes, skipped } = (body ?? {}) as { changes?: unknown; skipped?: unknown };
  const result: WriteResult = { changes: typeof changes === "number" ? changes : 0 };
  if (typeof skipped === "string" && SKIPS.includes(skipped)) result.skipped = skipped as WriteSkip;
  return result;
}

/** The data server's answer for a row write to a key no live row holds. */
function isMissingRow(status: number, body: unknown): boolean {
  return status === 404 && (body as { skipped?: unknown } | null)?.skipped === "missing";
}

export function createRowClient(transport: Transport): RowClient {
  async function call<T>(table: string, path: string, init: RequestInit, acceptMissing = false): Promise<T> {
    const res = await transport(path, init);
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (acceptMissing && isMissingRow(res.status, body)) return body as T;
    if (!res.ok) {
      const message =
        body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : text || res.statusText;
      throw new RowApiError(table, res.status, message);
    }
    return body as T;
  }

  async function select<T extends Row = Row>(table: string, opts: SelectOptions = {}): Promise<SelectResult<T>> {
    const query = buildQuery(opts);
    const body = await call<{ rows?: T[]; truncated?: boolean; page_token?: string | null }>(
      table,
      query ? `${tablePath(table)}?${query}` : tablePath(table),
      { method: "GET" },
    );
    return { rows: body?.rows ?? [], truncated: !!body?.truncated, pageToken: body?.page_token ?? null };
  }

  return {
    select,
    async selectAll<T extends Row = Row>(table: string, opts: Omit<SelectOptions, "limit" | "pageToken"> = {}) {
      const out: T[] = [];
      let pageToken: string | undefined;
      for (;;) {
        const page = await select<T>(table, { ...opts, limit: MAX_PAGE, pageToken });
        out.push(...page.rows);
        if (page.pageToken) {
          pageToken = page.pageToken;
          continue;
        }
        if (page.truncated) {
          // A short page with no way to continue: returning it would be the
          // silent truncation selectAll exists to prevent.
          throw new RowApiError(table, 200, "response truncated without a page_token");
        }
        return out;
      }
    },
    async aggregate<T extends Row = Row>(table: string, opts: AggregateOptions) {
      const query = buildQuery({
        where: opts.where,
        select: opts.groupBy,
        aggregate: opts.aggregate,
        order: opts.order,
        limit: opts.limit,
      });
      const body = await call<{ groups?: T[]; truncated?: boolean }>(table, `${tablePath(table)}?${query}`, {
        method: "GET",
      });
      return { groups: body?.groups ?? [], truncated: !!body?.truncated };
    },
    async insert(table, row, opts = {}) {
      const body = await call(table, tablePath(table), {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(opts.ifAbsent ? { row, ifAbsent: true } : { row }),
      });
      return writeResult(body);
    },
    async patch(table, where, patch) {
      const body = await call(
        table,
        tablePath(table),
        { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ where: encodeWhere(where), patch }) },
        true,
      );
      return writeResult(body);
    },
    async remove(table, where) {
      const body = await call(
        table,
        tablePath(table),
        { method: "DELETE", headers: JSON_HEADERS, body: JSON.stringify({ where: encodeWhere(where) }) },
        true,
      );
      return writeResult(body);
    },
  };
}
