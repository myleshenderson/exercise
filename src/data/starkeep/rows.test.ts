import { describe, expect, test, vi, afterEach } from "vitest";
import { createRowClient, RowApiError, type Transport } from "./rows";
import { browserTransport, localDataUrl } from "./browserTransport";

interface Call {
  path: string;
  init: RequestInit;
}

/** A transport that records each call and answers from a queue. */
function recorder(...responses: unknown[]) {
  const calls: Call[] = [];
  const transport: Transport = async (path, init) => {
    calls.push({ path, init });
    const next = responses.shift() ?? { rows: [], truncated: false, page_token: null };
    return new Response(JSON.stringify(next), { status: 200 });
  };
  return { calls, client: createRowClient(transport) };
}

function query(path: string): Record<string, string> {
  return Object.fromEntries(new URL(path, "http://x").searchParams.entries());
}

describe("select", () => {
  test("GET /app-data/db/<table> with where, select, order, limit and page_token encoded", async () => {
    const { calls, client } = recorder({ rows: [{ id: "a" }], truncated: true, page_token: "tok2" });
    const result = await client.select("workout_days", {
      where: {
        archived_at: null,
        name: "Leg Day",
        position: { gte: 1, lt: 5 },
        id: { in: ["a", "b"] },
        program_id: { eq: "p1" },
        cue: { like: "%a\\_b%" },
        label: { prefix: "x/" },
        flag: { ne: "n" },
        done: { is: true },
      },
      select: ["id", "name"],
      order: ["position.asc", "created_at.desc.nullsfirst"],
      limit: 50,
      pageToken: "tok 1+/=",
    });

    expect(result).toEqual({ rows: [{ id: "a" }], truncated: true, pageToken: "tok2" });
    expect(calls).toHaveLength(1);
    expect(calls[0].init).toEqual({ method: "GET" });
    expect(calls[0].path).toBe(
      "/app-data/db/workout_days?" +
        "where=%7B%22archived_at%22%3A%7B%22is%22%3Anull%7D%2C%22name%22%3A%22Leg+Day%22%2C" +
        "%22position%22%3A%7B%22gte%22%3A1%2C%22lt%22%3A5%7D%2C%22id%22%3A%7B%22in%22%3A%5B%22a%22%2C%22b%22%5D%7D%2C" +
        "%22program_id%22%3A%22p1%22%2C%22cue%22%3A%7B%22like%22%3A%22%25a%5C%5C_b%25%22%7D%2C" +
        "%22label%22%3A%7B%22prefix%22%3A%22x%2F%22%7D%2C%22flag%22%3A%7B%22ne%22%3A%22n%22%7D%2C" +
        "%22done%22%3A%7B%22is%22%3Atrue%7D%7D" +
        "&select=id%2Cname&order=position.asc%2Ccreated_at.desc.nullsfirst&limit=50&page_token=tok+1%2B%2F%3D",
    );
    // Decoded, the parameters are exactly the grammar's.
    expect(query(calls[0].path)).toEqual({
      where: JSON.stringify({
        archived_at: { is: null },
        name: "Leg Day",
        position: { gte: 1, lt: 5 },
        id: { in: ["a", "b"] },
        program_id: "p1",
        cue: { like: "%a\\_b%" },
        label: { prefix: "x/" },
        flag: { ne: "n" },
        done: { is: true },
      }),
      select: "id,name",
      order: "position.asc,created_at.desc.nullsfirst",
      limit: "50",
      page_token: "tok 1+/=",
    });
  });

  test("no options → bare path, no query string", async () => {
    const { calls, client } = recorder();
    await client.select("programs");
    expect(calls[0].path).toBe("/app-data/db/programs");
  });

  test("table names are path-encoded", async () => {
    const { calls, client } = recorder();
    await client.select("a b/c");
    expect(calls[0].path).toBe("/app-data/db/a%20b%2Fc");
  });

  test("eq combined with another operator on one column is refused", async () => {
    const { client } = recorder();
    await expect(client.select("t", { where: { a: { eq: 1, gt: 0 } } })).rejects.toThrow(/eq alone/);
  });
});

describe("selectAll", () => {
  test("asks for 500 a page and follows page_token until it is exhausted, resending where and order", async () => {
    const { calls, client } = recorder(
      { rows: [{ id: "1" }, { id: "2" }], truncated: true, page_token: "p2" },
      { rows: [{ id: "3" }], truncated: true, page_token: "p3" },
      { rows: [{ id: "4" }], truncated: false, page_token: null },
    );
    const rows = await client.selectAll("sessions", { where: { workout_day_id: "d" }, order: ["performed_on.desc"] });
    expect(rows.map((r) => r.id)).toEqual(["1", "2", "3", "4"]);
    expect(calls.map((c) => query(c.path))).toEqual([
      { where: '{"workout_day_id":"d"}', order: "performed_on.desc", limit: "500" },
      { where: '{"workout_day_id":"d"}', order: "performed_on.desc", limit: "500", page_token: "p2" },
      { where: '{"workout_day_id":"d"}', order: "performed_on.desc", limit: "500", page_token: "p3" },
    ]);
  });

  test("a truncated page without a page_token is an error, never a silent short result", async () => {
    const { client } = recorder({ rows: [{ id: "1" }], truncated: true, page_token: null });
    await expect(client.selectAll("sessions")).rejects.toBeInstanceOf(RowApiError);
  });
});

test("aggregate sends select as the GROUP BY list and aggregate as JSON", async () => {
  const { calls, client } = recorder({ groups: [{ session_id: "s1", n: 3 }], truncated: false });
  const result = await client.aggregate("session_sets", {
    where: { session_id: { in: ["s1", "s2"] } },
    groupBy: ["session_id"],
    aggregate: { n: { fn: "count" }, top: { fn: "max", col: "weight" } },
    order: ["n.desc"],
    limit: 10,
  });
  expect(result).toEqual({ groups: [{ session_id: "s1", n: 3 }], truncated: false });
  expect(calls[0].init).toEqual({ method: "GET" });
  expect(calls[0].path.startsWith("/app-data/db/session_sets?")).toBe(true);
  expect(query(calls[0].path)).toEqual({
    where: '{"session_id":{"in":["s1","s2"]}}',
    select: "session_id",
    aggregate: '{"n":{"fn":"count"},"top":{"fn":"max","col":"weight"}}',
    order: "n.desc",
    limit: "10",
  });
});

test("insert: POST { row } with a JSON content type", async () => {
  const { calls, client } = recorder({ ok: true });
  await client.insert("programs", { id: "p1", name: "Base", created_at: "2026-01-01T00:00:00.000Z", archived_at: null });
  expect(calls[0]).toEqual({
    path: "/app-data/db/programs",
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"row":{"id":"p1","name":"Base","created_at":"2026-01-01T00:00:00.000Z","archived_at":null}}',
    },
  });
});

test("patch: PATCH { where, patch } and returns changes", async () => {
  const { calls, client } = recorder({ changes: 2 });
  const changes = await client.patch("workout_days", { id: "d1", archived_at: null }, { name: "X" });
  expect(changes).toBe(2);
  expect(calls[0]).toEqual({
    path: "/app-data/db/workout_days",
    init: {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: '{"where":{"id":"d1","archived_at":{"is":null}},"patch":{"name":"X"}}',
    },
  });
});

test("remove: DELETE { where } and returns changes", async () => {
  const { calls, client } = recorder({ changes: 1 });
  const changes = await client.remove("session_sets", { session_id: "s1", exercise_id: { in: ["e1"] } });
  expect(changes).toBe(1);
  expect(calls[0]).toEqual({
    path: "/app-data/db/session_sets",
    init: {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: '{"where":{"session_id":"s1","exercise_id":{"in":["e1"]}}}',
    },
  });
});

test("a non-2xx response throws RowApiError carrying the server's error message", async () => {
  const client = createRowClient(async () => new Response(JSON.stringify({ error: "limit must be ≤ 500" }), { status: 400 }));
  const err = await client.select("t").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RowApiError);
  expect((err as RowApiError).status).toBe(400);
  expect((err as RowApiError).message).toContain("limit must be ≤ 500");
});

describe("browserTransport", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("prefixes BASE_URL + api/local-data and sends credentials", async () => {
    vi.stubEnv("BASE_URL", "/apps/exercise/");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await browserTransport("/app-data/db/programs?limit=1", { method: "GET" });
    expect(fetchMock).toHaveBeenCalledWith("/apps/exercise/api/local-data/app-data/db/programs?limit=1", {
      method: "GET",
      credentials: "include",
    });
  });

  test("BASE_URL / gives /api/local-data/…, and a base without a trailing slash still joins cleanly", () => {
    vi.stubEnv("BASE_URL", "/");
    expect(localDataUrl("/app-data/db/x")).toBe("/api/local-data/app-data/db/x");
    vi.stubEnv("BASE_URL", "/apps/exercise");
    expect(localDataUrl("/app-data/db/x")).toBe("/apps/exercise/api/local-data/app-data/db/x");
  });
});
