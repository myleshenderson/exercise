/**
 * Test-only: an in-memory implementation of Starkeep's `/app-data/db/<table>`
 * row API grammar (starkeep-core authoring guide §6a), behind the same
 * {@link Transport} signature the browser and server transports have.
 *
 * It is deliberately strict where the real server is strict, so a test that
 * passes here does not depend on leniency the platform lacks:
 * - Only declared tables and columns are accepted (pass the manifest's tables).
 * - Unknown top-level query parameters are a 400.
 * - `limit` defaults to 30 and refuses more than 500; pages continue only via
 *   the opaque `page_token`.
 * - `timestamp` columns accept only canonical `toISOString()` text.
 * - `notNull` columns are rejected on insert. A duplicate primary key is NOT
 *   an error: like the real applier (an `ON CONFLICT DO UPDATE` upsert,
 *   last writer wins), the later insert replaces the row, and revives a
 *   deleted one.
 * - `ifAbsent` on an insert writes nothing when a row holds the key, and
 *   answers `skipped: "live"`, or `"deleted"` for a deleted row (the fake
 *   keeps the keys it deleted, as the data server keeps tombstones).
 * - A `PATCH` or `DELETE` `where` must name the whole primary key, and every
 *   value in it must be a plain value, not an operator object (the data
 *   server's `requireKeyedWhere` and `checkValue`).
 * - A `PATCH` of a key no live row holds answers 404 with `skipped:
 *   "missing"`. A `DELETE` of a deleted row answers 200 with `skipped:
 *   "deleted"`, and of a key no row ever held, 404 with `skipped: "missing"`.
 * - `order` sorts nulls last unless told otherwise and appends the primary key.
 */
import type { Transport } from "./rows.js";

export interface FakeColumn {
  name: string;
  type: string;
  primaryKey?: boolean;
  notNull?: boolean;
}

export interface FakeTable {
  name: string;
  columns: FakeColumn[];
}

export interface FakeRequest {
  method: string;
  table: string;
  params: Record<string, string>;
  body: unknown;
}

export interface FakeTransport {
  transport: Transport;
  /** Live table contents, by table name. Tests may read or seed these directly. */
  tables: Record<string, Record<string, unknown>[]>;
  /** Every request received, in order. */
  requests: FakeRequest[];
}

const RESERVED = new Set(["where", "select", "aggregate", "order", "limit", "page_token", "include"]);
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 500;
const ISO_MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class BadRequest extends Error {}

/** A row write the data server answers with a status other than 200, and a body. */
class WriteAnswer extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? status));
  }
}

const MISSING = () => new WriteAnswer(404, { error: "No live row holds that key", changes: 0, skipped: "missing" });

type Row = Record<string, unknown>;

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function likeToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const next = pattern[i + 1];
      if (next !== "%" && next !== "_" && next !== "\\") throw new BadRequest(`bad escape in like pattern "${pattern}"`);
      out += next.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
      i++;
    } else if (c === "%") out += ".*";
    else if (c === "_") out += ".";
    else out += c.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "s");
}

function matchesCondition(value: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== "object" || Array.isArray(cond)) {
    if (cond === null) throw new BadRequest("equality with null; use {\"is\":null}");
    return value !== null && value !== undefined && value === cond;
  }
  const isNull = value === null || value === undefined;
  for (const [op, operand] of Object.entries(cond as Record<string, unknown>)) {
    switch (op) {
      case "is":
        if (operand === null) {
          if (!isNull) return false;
        } else if (operand === true || operand === false) {
          if (value !== operand) return false;
        } else throw new BadRequest("is takes null, true or false");
        break;
      case "lt":
        if (isNull || compare(value, operand) >= 0) return false;
        break;
      case "lte":
        if (isNull || compare(value, operand) > 0) return false;
        break;
      case "gt":
        if (isNull || compare(value, operand) <= 0) return false;
        break;
      case "gte":
        if (isNull || compare(value, operand) < 0) return false;
        break;
      case "ne":
        // SQL: `col <> v` is unknown (so excluded) for a null col.
        if (isNull || value === operand) return false;
        break;
      case "in":
        if (!Array.isArray(operand)) throw new BadRequest("in takes a JSON array");
        if (isNull || !operand.includes(value)) return false;
        break;
      case "prefix":
        if (typeof operand !== "string") throw new BadRequest("prefix takes a string");
        if (typeof value !== "string" || !value.startsWith(operand)) return false;
        break;
      case "like":
        if (typeof operand !== "string") throw new BadRequest("like takes a string");
        if (typeof value !== "string" || !likeToRegExp(operand).test(value)) return false;
        break;
      default:
        throw new BadRequest(`"${op}" is not a where operator`);
    }
  }
  return true;
}

export function createFakeTransport(schema: FakeTable[]): FakeTransport {
  const tables: Record<string, Row[]> = {};
  const byName = new Map<string, FakeTable>();
  for (const t of schema) {
    byName.set(t.name, t);
    tables[t.name] = [];
  }
  const requests: FakeRequest[] = [];
  /** Keys deleted, by table: the fake's tombstones. */
  const deleted = new Map<string, Set<unknown>>(schema.map((t) => [t.name, new Set()]));

  function tableSchema(name: string): FakeTable {
    const t = byName.get(name);
    if (!t) throw new BadRequest(`table "${name}" is not declared`);
    return t;
  }

  function column(t: FakeTable, name: string): FakeColumn {
    const c = t.columns.find((col) => col.name === name);
    if (!c) throw new BadRequest(`column "${name}" is not declared on "${t.name}"`);
    return c;
  }

  function pk(t: FakeTable): string {
    const c = t.columns.find((col) => col.primaryKey);
    if (!c) throw new BadRequest(`"${t.name}" declares no primary key`);
    return c.name;
  }

  function validateValue(t: FakeTable, name: string, value: unknown) {
    const c = column(t, name);
    if (value === null || value === undefined) {
      if (c.notNull) throw new BadRequest(`"${t.name}.${name}" is notNull`);
      return;
    }
    switch (c.type) {
      case "timestamp":
        if (typeof value !== "string" || !ISO_MS_UTC.test(value)) {
          throw new BadRequest(`"${t.name}.${name}" is declared timestamp and received ${JSON.stringify(value)}`);
        }
        break;
      case "text":
        if (typeof value !== "string") throw new BadRequest(`"${t.name}.${name}" is declared text and received ${typeof value}`);
        break;
      case "integer":
      case "bigint":
        if (typeof value !== "number" || !Number.isInteger(value)) {
          throw new BadRequest(`"${t.name}.${name}" is declared ${c.type} and received ${JSON.stringify(value)}`);
        }
        break;
      case "real":
        if (typeof value !== "number") throw new BadRequest(`"${t.name}.${name}" is declared real and received ${typeof value}`);
        break;
      case "boolean":
        if (typeof value !== "boolean") throw new BadRequest(`"${t.name}.${name}" is declared boolean`);
        break;
    }
  }

  function filter(t: FakeTable, where: Record<string, unknown> | undefined): Row[] {
    const rows = tables[t.name];
    if (!where) return rows.slice();
    for (const col of Object.keys(where)) column(t, col);
    return rows.filter((r) => Object.entries(where).every(([col, cond]) => matchesCondition(r[col], cond)));
  }

  function parseJsonParam(raw: string | undefined, name: string): Record<string, unknown> | undefined {
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequest(`${name} is not valid JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadRequest(`${name} must be a JSON object`);
    return parsed as Record<string, unknown>;
  }

  function sortRows(t: FakeTable, rows: Row[], orderRaw: string | undefined, appendPk: boolean): Row[] {
    const terms = (orderRaw ? orderRaw.split(",") : []).filter(Boolean).map((term) => {
      const [col, ...mods] = term.split(".");
      column(t, col);
      let dir = 1;
      let nullsFirst = false;
      for (const m of mods) {
        if (m === "asc") dir = 1;
        else if (m === "desc") dir = -1;
        else if (m === "nullsfirst") nullsFirst = true;
        else if (m === "nullslast") nullsFirst = false;
        else throw new BadRequest(`"${m}" is not an order modifier`);
      }
      return { col, dir, nullsFirst };
    });
    if (appendPk) {
      const key = pk(t);
      if (!terms.some((x) => x.col === key)) terms.push({ col: key, dir: 1, nullsFirst: false });
    }
    return rows.slice().sort((a, b) => {
      for (const { col, dir, nullsFirst } of terms) {
        const av = a[col] ?? null;
        const bv = b[col] ?? null;
        if (av === null && bv === null) continue;
        if (av === null) return nullsFirst ? -1 : 1;
        if (bv === null) return nullsFirst ? 1 : -1;
        const c = compare(av, bv) * dir;
        if (c !== 0) return c;
      }
      return 0;
    });
  }

  function handleGet(t: FakeTable, params: Record<string, string>) {
    for (const name of Object.keys(params)) {
      if (!RESERVED.has(name)) throw new BadRequest(`"${name}" is not a query parameter`);
    }
    const where = parseJsonParam(params.where, "where");
    const select = params.select ? params.select.split(",") : undefined;
    select?.forEach((c) => column(t, c));
    const limit = params.limit === undefined ? DEFAULT_LIMIT : Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new BadRequest(`limit must be an integer from 1 to ${MAX_LIMIT}`);
    }
    const matched = filter(t, where);

    const aggregate = parseJsonParam(params.aggregate, "aggregate");
    if (aggregate) {
      if (params.page_token) throw new BadRequest("page_token addresses a row and an aggregate result holds none");
      const groupCols = select ?? [];
      const groups = new Map<string, Row[]>();
      for (const r of matched) {
        const key = JSON.stringify(groupCols.map((c) => r[c] ?? null));
        const g = groups.get(key);
        if (g) g.push(r);
        else groups.set(key, [r]);
      }
      if (groupCols.length === 0 && groups.size === 0) groups.set("[]", []);
      let out: Row[] = [...groups.values()].map((rows) => {
        const g: Row = {};
        for (const c of groupCols) g[c] = rows[0][c] ?? null;
        for (const [name, specRaw] of Object.entries(aggregate)) {
          const spec = specRaw as { fn: string; col?: string; distinct?: string };
          const col = spec.col ?? spec.distinct;
          if (col) column(t, col);
          const values = col ? rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined) : rows;
          switch (spec.fn) {
            case "count":
              g[name] = spec.distinct ? new Set(values).size : values.length;
              break;
            case "sum":
              g[name] = values.length ? (values as number[]).reduce((s, v) => s + v, 0) : null;
              break;
            case "avg":
              g[name] = values.length ? (values as number[]).reduce((s, v) => s + v, 0) / values.length : null;
              break;
            case "min":
              g[name] = values.length ? values.reduce((m, v) => (compare(v, m) < 0 ? v : m)) : null;
              break;
            case "max":
              g[name] = values.length ? values.reduce((m, v) => (compare(v, m) > 0 ? v : m)) : null;
              break;
            default:
              throw new BadRequest(`"${spec.fn}" is not an aggregate function`);
          }
        }
        return g;
      });
      if (params.order) out = sortRows(t, out, params.order, false);
      return { groups: out.slice(0, limit), truncated: out.length > limit };
    }

    const sorted = sortRows(t, matched, params.order, true);
    let offset = 0;
    if (params.page_token) {
      const decoded = Number(atob(params.page_token).replace(/^fake:/, ""));
      if (!Number.isInteger(decoded) || decoded < 0) throw new BadRequest("bad page_token");
      offset = decoded;
    }
    const page = sorted.slice(offset, offset + limit);
    const more = offset + limit < sorted.length;
    const rows = page.map((r) => {
      if (!select) return { ...r };
      return Object.fromEntries(select.map((c) => [c, r[c] ?? null]));
    });
    return { rows, truncated: more, page_token: more ? btoa(`fake:${offset + limit}`) : null };
  }

  /**
   * The `where` of a `PATCH` or `DELETE`: the whole primary key, each column a
   * plain value. Returns the rows it matches.
   */
  function keyedTargets(op: "update" | "delete", t: FakeTable, where: Record<string, unknown> | undefined): Row[] {
    if (!where || Object.keys(where).length === 0) {
      throw new BadRequest(`app-syncable ${op} for ${t.name} carries no "where"`);
    }
    for (const [col, value] of Object.entries(where)) {
      column(t, col);
      if (value !== null && typeof value === "object") {
        throw new BadRequest(`${t.name}: "${col}" is declared ${column(t, col).type} and received an object`);
      }
      validateValue(t, col, value);
    }
    const key = pk(t);
    if (where[key] === undefined) {
      throw new BadRequest(`app-syncable ${op} for ${t.name} names only part of the primary key (missing ${key})`);
    }
    return tables[t.name].filter((r) => Object.entries(where).every(([col, value]) => r[col] === value));
  }

  function handleWrite(method: string, t: FakeTable, body: Record<string, unknown>) {
    const key = pk(t);
    const tombstones = deleted.get(t.name)!;
    if (method === "POST") {
      const row = body.row as Row | undefined;
      if (!row || typeof row !== "object") throw new BadRequest("row is required");
      if (body.ifAbsent !== undefined && typeof body.ifAbsent !== "boolean") throw new BadRequest("ifAbsent must be a boolean");
      for (const [k, v] of Object.entries(row)) validateValue(t, k, v);
      const full: Row = {};
      for (const c of t.columns) {
        const v = row[c.name] ?? null;
        validateValue(t, c.name, v);
        full[c.name] = v;
      }
      const existing = tables[t.name].findIndex((r) => r[key] === full[key]);
      if (body.ifAbsent) {
        if (existing !== -1) return { ok: true, changes: 0, skipped: "live" };
        if (tombstones.has(full[key])) return { ok: true, changes: 0, skipped: "deleted" };
      }
      tombstones.delete(full[key]);
      if (existing !== -1) tables[t.name][existing] = full;
      else tables[t.name].push(full);
      return { ok: true, changes: 1 };
    }
    if (body.ifAbsent !== undefined) throw new BadRequest(`${method} does not take ifAbsent`);
    if (method === "PATCH") {
      const patch = body.patch as Row | undefined;
      if (!body.where || !patch) throw new BadRequest("where and patch are required");
      if (Object.keys(patch).length === 0) throw new BadRequest("patch is empty");
      for (const [k, v] of Object.entries(patch)) validateValue(t, k, v);
      const targets = keyedTargets("update", t, body.where as Record<string, unknown>);
      if (targets.length === 0) throw MISSING();
      for (const r of targets) Object.assign(r, patch);
      return { changes: targets.length };
    }
    if (method === "DELETE") {
      const where = body.where as Record<string, unknown> | undefined;
      if (!where) throw new BadRequest("where is required");
      const doomed = new Set(keyedTargets("delete", t, where));
      if (doomed.size === 0) {
        if (tombstones.has(where[key])) return { changes: 0, skipped: "deleted" };
        throw MISSING();
      }
      for (const r of doomed) tombstones.add(r[key]);
      tables[t.name] = tables[t.name].filter((r) => !doomed.has(r));
      return { changes: doomed.size };
    }
    throw new BadRequest(`method ${method} not allowed`);
  }

  const transport: Transport = async (path, init) => {
    const url = new URL(path, "http://fake.invalid");
    const match = url.pathname.match(/^\/app-data\/db\/([^/]+)$/);
    const method = (init.method ?? "GET").toUpperCase();
    const params = Object.fromEntries(url.searchParams.entries());
    let body: unknown = undefined;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    const table = match ? decodeURIComponent(match[1]) : "";
    requests.push({ method, table, params, body });
    try {
      if (!match) return json(404, { error: `no route for ${url.pathname}` });
      const t = tableSchema(table);
      if (method === "GET") return json(200, handleGet(t, params));
      return json(200, handleWrite(method, t, (body ?? {}) as Record<string, unknown>));
    } catch (err) {
      if (err instanceof BadRequest) return json(400, { error: err.message });
      if (err instanceof WriteAnswer) return json(err.status, err.body);
      throw err;
    }
  };

  return { transport, tables, requests };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
