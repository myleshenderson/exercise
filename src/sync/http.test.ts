import { describe, expect, it } from "vitest";
import { fetchWithRetry, politePause, type FetchLike } from "./http.js";

function scripted(statuses: (number | [number, Record<string, string>])[]) {
  const calls: string[] = [];
  const f: FetchLike = async (url) => {
    calls.push(url);
    const next = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    const [status, headers] = Array.isArray(next) ? next : [next, {}];
    return new Response(status === 204 ? null : "body", { status, headers });
  };
  return { f, calls };
}

function recorder() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

describe("fetchWithRetry", () => {
  it("retries 429 and 5xx with 2, 4, 8 s and returns the last response", async () => {
    const { f, calls } = scripted([503, 429, 500, 502]);
    const { delays, sleep } = recorder();
    const res = await fetchWithRetry(f, "https://x.test/a", undefined, { sleep });
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(4);
    expect(delays).toEqual([2000, 4000, 8000]);
  });

  it("stops at the first non-retryable response", async () => {
    const { f, calls } = scripted([500, 200]);
    const { delays, sleep } = recorder();
    expect((await fetchWithRetry(f, "u", undefined, { sleep })).status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([2000]);
    const notFound = scripted([404]);
    expect((await fetchWithRetry(notFound.f, "u", undefined, { sleep })).status).toBe(404);
    expect(notFound.calls).toHaveLength(1);
  });

  it("honours Retry-After seconds and ignores a date", async () => {
    const { f } = scripted([[429, { "Retry-After": "7" }], [429, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }], 200]);
    const { delays, sleep } = recorder();
    await fetchWithRetry(f, "u", undefined, { sleep });
    expect(delays).toEqual([7000, 4000]);
  });

  it("respects retries and baseDelayMs", async () => {
    const { f, calls } = scripted([500]);
    const { delays, sleep } = recorder();
    await fetchWithRetry(f, "u", undefined, { retries: 1, baseDelayMs: 10, sleep });
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([10]);
  });
});

describe("politePause", () => {
  it("sleeps 1000 ms by default", async () => {
    const { delays, sleep } = recorder();
    await politePause(sleep);
    await politePause(sleep, 250);
    expect(delays).toEqual([1000, 250]);
  });
});
