/**
 * Test-only: a recording stub of the slice of the supabase-js query builder
 * that `src/data/supabase.ts` calls, the Supabase counterpart of
 * `starkeep/fakeTransport.ts`.
 *
 * Unlike the stateful fake in `supabase.test.ts`, this stub holds no tables.
 * Every `from(table)` call opens one {@link RecordedQuery}; each builder
 * method called on it is appended to `steps`, and awaiting the chain resolves
 * to a canned `{ data, error }` the test queued with `reply()`. The reply is
 * bound when the query is opened (its first verb after `from()`), so queue
 * replies before calling the DataLayer method: a query opened while the queue
 * is empty resolves to `{ data: null, error: null }`, and a later `reply()`
 * cannot answer it.
 *
 * Table-backed reads (AI-667): pass `tables` (and the `foreignKeys` that
 * relate them) and a `select` opened while the reply queue is empty is
 * answered from those rows instead of `{ data: null }`, so a test can compare
 * two read paths over the same data and count the requests each issues. The
 * evaluator understands the PostgREST syntax the strength reads send through
 * supabase-js: embeds in the select string (`sessions!inner(a, b)`, nested
 * `sessions!inner(id, session_sets(x))`, aliased `probe:session_sets!inner(id)`),
 * where an `!inner` embed with no related row drops its parent; filters on a
 * top-level embed's column (`.lt("sessions.performed_on", d)`); ordering by a
 * to-one embedded column (`.order("sessions(performed_on)", { ascending: false })`);
 * `.limit`, `.limit(n, { referencedTable })` on a to-many embed, `.range` and
 * the `max-rows` cap (`maxRows`, default 1000). Anything else in that syntax
 * (nested filter paths, `nullsFirst`, `range` or `order` on an embed,
 * `foreignTable`) throws. Writes are only recorded; they never change `tables`.
 *
 * Only the methods `supabase.ts` actually calls exist (grep
 * `\.from(` in that file); calling anything else throws a TypeError, so a
 * test fails loudly if the layer starts using a builder method this stub
 * does not model. There is no `rpc`: the layer never calls it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type Operation = "select" | "insert" | "update" | "upsert" | "delete";

export interface Step {
  method: string;
  args: unknown[];
}

export interface RecordedQuery {
  table: string;
  /** The first verb called after `from()`. */
  op: Operation;
  /** The insert/update/upsert payload, as passed. */
  payload?: unknown;
  /** Every builder call after `from()`, verb included, in call order. */
  steps: Step[];
}

export interface StubError {
  message: string;
  code?: string;
}

export interface StubResponse {
  data?: unknown;
  error?: StubError | null;
}

export interface SupabaseStub {
  client: SupabaseClient;
  /** Every query opened, in `from()` order. */
  queries: RecordedQuery[];
  /** Queue canned responses, consumed one per query in the order queries are opened. */
  reply(...responses: StubResponse[]): void;
  /** The filters (`eq`, `is`, `not`, `lt`, `gte`, `lte`) applied to a query, as `[method, ...args]` tuples. */
  filters(query: RecordedQuery): unknown[][];
}

const FILTERS = new Set(["eq", "is", "not", "lt", "gte", "lte"]);

export type StubRow = Record<string, unknown>;

/** `from.column` references `to.id`: `from` embeds `to` as one row, `to` embeds `from` as an array. */
export interface StubForeignKey {
  from: string;
  column: string;
  to: string;
}

export interface StubOptions {
  tables?: Record<string, StubRow[]>;
  foreignKeys?: StubForeignKey[];
  /** PostgREST `max-rows`: top-level rows per response. */
  maxRows?: number;
}

/** One node of a parsed select string: plain columns (`*` allowed) and embeds. */
interface SelectNode {
  columns: string[];
  /** `key` is the alias (`probe:session_sets(...)`) or, without one, the table name. */
  embeds: Array<{ key: string; table: string; inner: boolean; node: SelectNode }>;
}

/** Splits on commas outside parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Parses a PostgREST select string: `a, b, rel!inner(c, nested(d)), alias:rel(e)`. */
export function parseSelect(text: string): SelectNode {
  const node: SelectNode = { columns: [], embeds: [] };
  for (const part of splitTopLevel(text)) {
    const m = /^(?:([a-z_][a-z0-9_]*):)?([a-z_][a-z0-9_]*)(!inner)?\((.*)\)$/is.exec(part);
    if (m) {
      const key = m[1] ?? m[2];
      if (node.embeds.some((e) => e.key === key)) throw new TypeError(`supabaseStub: embed "${key}" appears twice without an alias`);
      node.embeds.push({ key, table: m[2], inner: m[3] !== undefined, node: parseSelect(m[4]) });
    } else if (/^(\*|[a-z_][a-z0-9_]*)$/i.test(part)) node.columns.push(part);
    else throw new TypeError(`supabaseStub: unsupported select item "${part}"`);
  }
  return node;
}

function compare(a: unknown, b: unknown, ascending: boolean): number {
  // PostgREST default: nulls last ascending, nulls first descending.
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an || bn) return an && bn ? 0 : (an ? 1 : -1) * (ascending ? 1 : -1);
  const c = (a as number | string) < (b as number | string) ? -1 : (a as number | string) > (b as number | string) ? 1 : 0;
  return ascending ? c : -c;
}

function matches(value: unknown, method: string, args: unknown[]): boolean {
  const v = args[args.length - 1];
  switch (method) {
    case "eq":
      return value === v;
    case "is":
      return v === null ? value === null || value === undefined : value === v;
    case "not":
      if (args[1] !== "is") throw new TypeError(`supabaseStub: unsupported not operator "${String(args[1])}"`);
      return !matches(value, "is", [v]);
    case "lt":
      return value !== null && value !== undefined && (value as string) < (v as string);
    case "gte":
      return value !== null && value !== undefined && (value as string) >= (v as string);
    case "lte":
      return value !== null && value !== undefined && (value as string) <= (v as string);
    default:
      throw new TypeError(`supabaseStub: unsupported filter "${method}"`);
  }
}

export function createSupabaseStub(options: StubOptions = {}): SupabaseStub {
  const queries: RecordedQuery[] = [];
  const queue: StubResponse[] = [];
  const tables = options.tables;
  const foreignKeys = options.foreignKeys ?? [];
  const maxRows = options.maxRows ?? 1000;

  /** Resolves `name` embedded from `table`: whether it is one row or many, and which foreign-key column to look up. */
  function relation(table: string, name: string) {
    const toOne = foreignKeys.find((fk) => fk.from === table && fk.to === name);
    if (toOne) return { one: true, column: "id", value: (row: StubRow) => row[toOne.column] };
    const toMany = foreignKeys.find((fk) => fk.to === table && fk.from === name);
    if (toMany) return { one: false, column: toMany.column, value: (row: StubRow) => row.id };
    throw new TypeError(`supabaseStub: no foreign key between ${table} and ${name}`);
  }

  /** The option bag of a `limit`/`range`/`order` step; `foreignTable` (the deprecated spelling) is not modelled. */
  function stepOptions(step: Step, index: number) {
    const opts = (step.args[index] ?? {}) as { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string; foreignTable?: string };
    if (opts.foreignTable !== undefined) throw new TypeError(`supabaseStub: ${step.method}({ foreignTable }) is not modelled`);
    return opts;
  }

  /**
   * Evaluates a recorded select against `tables`. Each row is first expanded
   * (embeds attached as full related rows) so filters and ordering can reach
   * embedded columns, then projected to the selected columns.
   */
  function evaluate(query: RecordedQuery): { data: unknown; error: StubError | null } {
    const select = parseSelect(String(query.steps[0].args[0] ?? "*"));
    type Expanded = { row: StubRow; embeds: Record<string, Expanded | Expanded[] | null> };
    // Rows of `table` by the value of `column`, built once per table and column for this evaluation.
    const indexes = new Map<string, Map<unknown, StubRow[]>>();
    const lookup = (table: string, column: string, value: unknown): StubRow[] => {
      if (value === null || value === undefined) return [];
      const key = `${table}.${column}`;
      let index = indexes.get(key);
      if (!index) {
        index = new Map();
        for (const r of tables![table] ?? []) {
          const list = index.get(r[column]);
          if (list) list.push(r);
          else index.set(r[column], [r]);
        }
        indexes.set(key, index);
      }
      return index.get(value) ?? [];
    };
    // An `!inner` embed with no related row drops its parent, as PostgREST's inner join does.
    const expand = (table: string, row: StubRow, node: SelectNode): Expanded | null => {
      const embeds: Expanded["embeds"] = {};
      for (const e of node.embeds) {
        const rel = relation(table, e.table);
        const related = lookup(e.table, rel.column, rel.value(row))
          .map((o) => expand(e.table, o, e.node))
          .filter((o): o is Expanded => o !== null);
        if (e.inner && related.length === 0) return null;
        embeds[e.key] = rel.one ? (related[0] ?? null) : related;
      }
      return { row, embeds };
    };
    const project = (x: Expanded, node: SelectNode): StubRow => {
      const out: StubRow = {};
      for (const c of node.columns) {
        if (c === "*") Object.assign(out, x.row);
        else out[c] = x.row[c];
      }
      for (const e of node.embeds) {
        const v = x.embeds[e.key];
        out[e.key] = Array.isArray(v) ? v.map((y) => project(y, e.node)) : v ? project(v, e.node) : null;
      }
      return out;
    };
    const topEmbed = (name: string, what: string) => {
      const embed = select.embeds.find((e) => e.key === name);
      if (!embed) throw new TypeError(`supabaseStub: ${what} names "${name}", which is not embedded`);
      return embed;
    };

    let rows = (tables![query.table] ?? [])
      .map((r) => expand(query.table, r, select))
      .filter((x): x is Expanded => x !== null);
    // Filters: `col` applies to the row; `rel.col` filters the embedded rows,
    // and an `!inner` embed left with no match drops the parent row.
    for (const step of query.steps.filter((s) => FILTERS.has(s.method))) {
      const column = String(step.args[0]);
      const dot = column.indexOf(".");
      if (dot === -1) {
        rows = rows.filter((x) => matches(x.row[column], step.method, step.args));
        continue;
      }
      const name = column.slice(0, dot);
      const col = column.slice(dot + 1);
      if (col.includes(".")) throw new TypeError(`supabaseStub: unsupported filter on nested embed path "${column}"`);
      const embed = topEmbed(name, `filter on "${column}"`);
      rows = rows.filter((x) => {
        const v = x.embeds[name];
        if (Array.isArray(v)) {
          const kept = v.filter((y) => matches(y.row[col], step.method, step.args));
          x.embeds[name] = kept;
          return !embed.inner || kept.length > 0;
        }
        const keep = v !== null && matches(v.row[col], step.method, step.args);
        if (!keep) x.embeds[name] = null;
        return !embed.inner || keep;
      });
    }
    // Ordering: `col`, or `rel(col)` for a to-one embed.
    const orders = query.steps
      .filter((s) => s.method === "order")
      .map((s) => {
        const opts = stepOptions(s, 1);
        if (opts.referencedTable !== undefined) {
          throw new TypeError("supabaseStub: ordering embedded rows (referencedTable) is not modelled");
        }
        if (opts.nullsFirst !== undefined) throw new TypeError("supabaseStub: order({ nullsFirst }) is not modelled");
        const column = String(s.args[0]);
        const m = /^([a-z_][a-z0-9_]*)\(([a-z_][a-z0-9_]*)\)$/i.exec(column);
        const get = m
          ? (x: Expanded) => {
              const v = x.embeds[m[1]];
              if (Array.isArray(v)) throw new TypeError(`supabaseStub: cannot order by to-many embed "${m[1]}"`);
              return v?.row[m[2]];
            }
          : (x: Expanded) => x.row[column];
        return { get, ascending: opts.ascending ?? true };
      });
    rows = rows
      .map((x, i) => ({ x, i }))
      .sort((a, b) => {
        for (const o of orders) {
          const c = compare(o.get(a.x), o.get(b.x), o.ascending);
          if (c !== 0) return c;
        }
        return a.i - b.i;
      })
      .map(({ x }) => x);
    // limit(n, { referencedTable }) caps the embedded rows of each parent (in
    // table order: ordering embedded rows is not modelled); range on an embed is not modelled.
    let range: Step | undefined;
    let limit: Step | undefined;
    for (const s of query.steps) {
      if (s.method !== "range" && s.method !== "limit") continue;
      const ref = stepOptions(s, s.method === "range" ? 2 : 1).referencedTable;
      if (ref === undefined) {
        if (s.method === "range") range = s;
        else limit = s;
        continue;
      }
      if (s.method === "range") throw new TypeError("supabaseStub: range({ referencedTable }) is not modelled");
      if (ref.includes(".")) throw new TypeError(`supabaseStub: limit on nested embed "${ref}" is not modelled`);
      topEmbed(ref, "limit({ referencedTable })");
      const n = s.args[0] as number;
      for (const x of rows) {
        const v = x.embeds[ref];
        if (!Array.isArray(v)) throw new TypeError(`supabaseStub: limit on to-one embed "${ref}" is not modelled`);
        x.embeds[ref] = v.slice(0, n);
      }
    }
    // supabase-js turns .range() into offset/limit, overriding an earlier .limit().
    if (range) rows = rows.slice(range.args[0] as number, (range.args[1] as number) + 1);
    else if (limit) rows = rows.slice(0, limit.args[0] as number);
    rows = rows.slice(0, maxRows);
    const data = rows.map((x) => project(x, select));
    const mode = query.steps[query.steps.length - 1].method;
    if (mode === "maybeSingle") return { data: data[0] ?? null, error: null };
    if (mode === "single") {
      return data.length === 1
        ? { data: data[0], error: null }
        : { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
    }
    return { data, error: null };
  }

  function builder(query: RecordedQuery) {
    const queued = queue.shift();
    const response = queued ?? {};
    const fromTables = queued === undefined && tables !== undefined && query.op === "select";
    const record =
      (method: string) =>
      (...args: unknown[]) => {
        query.steps.push({ method, args });
        return api;
      };
    const api = {
      select: record("select"),
      eq: record("eq"),
      is: record("is"),
      not: record("not"),
      lt: record("lt"),
      gte: record("gte"),
      lte: record("lte"),
      order: record("order"),
      limit: record("limit"),
      range: record("range"),
      single: record("single"),
      maybeSingle: record("maybeSingle"),
      then<T1 = { data: unknown; error: StubError | null }, T2 = never>(
        onfulfilled?: ((v: { data: unknown; error: StubError | null }) => T1 | PromiseLike<T1>) | null,
        onrejected?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
      ): Promise<T1 | T2> {
        const result = fromTables ? evaluate(query) : { data: response.data ?? null, error: response.error ?? null };
        return Promise.resolve(result).then(onfulfilled, onrejected);
      },
    };
    return api;
  }

  function open(table: string, op: Operation, args: unknown[], payload?: unknown) {
    const query: RecordedQuery = { table, op, steps: [{ method: op, args }] };
    if (payload !== undefined) query.payload = payload;
    queries.push(query);
    return builder(query);
  }

  const client = {
    from: (table: string) => ({
      select: (...args: unknown[]) => open(table, "select", args),
      insert: (payload: unknown) => open(table, "insert", [payload], payload),
      update: (payload: unknown) => open(table, "update", [payload], payload),
      upsert: (payload: unknown, options?: unknown) =>
        open(table, "upsert", options === undefined ? [payload] : [payload, options], payload),
      delete: () => open(table, "delete", []),
    }),
  } as unknown as SupabaseClient;

  return {
    client,
    queries,
    reply: (...responses) => {
      queue.push(...responses);
    },
    filters: (query) => query.steps.filter((s) => FILTERS.has(s.method)).map((s) => [s.method, ...s.args]),
  };
}
