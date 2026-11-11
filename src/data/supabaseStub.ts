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

export function createSupabaseStub(): SupabaseStub {
  const queries: RecordedQuery[] = [];
  const queue: StubResponse[] = [];

  function builder(query: RecordedQuery) {
    const response = queue.shift() ?? {};
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
        return Promise.resolve({ data: response.data ?? null, error: response.error ?? null }).then(onfulfilled, onrejected);
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
