/** A fake Garmin Personal API behind an injected fetch, for the adapter tests. */
import { TOKEN_PATH } from "../client.js";
import type { GarminDetail, GarminListItem, GarminWeightRange } from "../types.js";
import { DETAIL, SYNTHETIC_JWT, fitZip } from "./garmin.js";

export interface FakeCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
}

export interface FakeGarminOptions {
  /** Token responses in order; the last repeats. Default: 200 with SYNTHETIC_JWT. */
  tokens?: (() => Response)[];
  /** Search response for a request (all list items when the function is absent). */
  search?: (q: URLSearchParams) => GarminListItem[] | Response;
  detail?: (id: string) => GarminDetail | Response;
  fit?: (id: string) => Uint8Array | Response;
  weight?: (start: string, end: string) => GarminWeightRange | Response;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function fakeGarmin(o: FakeGarminOptions = {}) {
  const calls: FakeCall[] = [];
  let tokenIndex = 0;
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({ method: init?.method ?? "GET", url, headers });
    const path = url.pathname;
    if (path === TOKEN_PATH) {
      const tokens = o.tokens ?? [() => new Response(`"${SYNTHETIC_JWT}"\n`, { status: 200 })];
      const r = tokens[Math.min(tokenIndex, tokens.length - 1)]!;
      tokenIndex++;
      return r();
    }
    if (path === "/activitylist-service/activities/search/activities") {
      const r = o.search ? o.search(url.searchParams) : [];
      return r instanceof Response ? r : json(r);
    }
    let m = /^\/activity-service\/activity\/(\d+)$/.exec(path);
    if (m) {
      const r = o.detail ? o.detail(m[1]!) : { ...DETAIL, activityId: Number(m[1]) };
      return r instanceof Response ? r : json(r);
    }
    m = /^\/download-service\/files\/activity\/(\d+)$/.exec(path);
    if (m) {
      const r = o.fit ? o.fit(m[1]!) : fitZip();
      return r instanceof Response ? r : new Response(r as BodyInit, { status: 200 });
    }
    m = /^\/weight-service\/weight\/range\/([\d-]+)\/([\d-]+)$/.exec(path);
    if (m) {
      const r = o.weight ? o.weight(m[1]!, m[2]!) : { dailyWeightSummaries: [] };
      return r instanceof Response ? r : json(r);
    }
    return json({ message: "not found" }, 404);
  };
  const dataCalls = () => calls.filter((c) => c.url.pathname !== TOKEN_PATH);
  const tokenCalls = () => calls.filter((c) => c.url.pathname === TOKEN_PATH);
  return { fetch, calls, dataCalls, tokenCalls };
}

/** Pages a fixed list newest first by `start`/`limit`, as Garmin does. */
export function pagedSearch(items: GarminListItem[]) {
  return (q: URLSearchParams) => {
    const start = Number(q.get("start") ?? 0);
    const limit = Number(q.get("limit") ?? 99);
    return items.slice(start, start + limit);
  };
}
