import { describe, expect, it } from "vitest";
import { GarminAuthError, createGarminClient, jwtExp } from "./client.js";
import { fakeGarmin } from "./__fixtures__/fakeGarmin.js";
import { JWT_IAT, LIST_PAGE, SYNTHETIC_JWT, makeJwt } from "./__fixtures__/garmin.js";

function setup(fake: ReturnType<typeof fakeGarmin>, nowMs = JWT_IAT * 1000) {
  const sleeps: number[] = [];
  const clock = { t: nowMs };
  const client = createGarminClient({
    fetch: fake.fetch,
    apiKey: "synthetic-key",
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => clock.t,
  });
  return { client, sleeps, clock };
}

describe("jwtExp", () => {
  it("reads exp from the base64url payload", () => {
    expect(jwtExp(SYNTHETIC_JWT)).toBe(JWT_IAT + 86_400);
    expect(jwtExp("not-a-jwt")).toBeNull();
    expect(jwtExp(makeJwt({ sub: "x" }))).toBeNull();
  });
});

describe("createGarminClient", () => {
  it("(a) caches the token, then re-exchanges inside 5 min of exp", async () => {
    const fake = fakeGarmin();
    const { client, clock } = setup(fake);
    const exp = (JWT_IAT + 86_400) * 1000;

    expect(await client.token()).toBe(SYNTHETIC_JWT); // quotes and newline stripped
    expect(await client.token()).toBe(SYNTHETIC_JWT);
    clock.t = exp - 301_000;
    await client.token();
    expect(fake.tokenCalls()).toHaveLength(1);

    clock.t = exp - 299_000;
    await client.token();
    expect(fake.tokenCalls()).toHaveLength(2);

    const call = fake.tokenCalls()[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.origin).toBe("https://personal.connectapi.garmin.com");
    expect(call.headers.Authorization).toBe("ApiKey synthetic-key");
  });

  it.each([401, 403, 500])("(b) a token %i throws GarminAuthError after exactly one request", async (status) => {
    const fake = fakeGarmin({ tokens: [() => new Response("{}", { status })] });
    const { client, sleeps } = setup(fake);
    await expect(client.token()).rejects.toThrow(new GarminAuthError(`GARMIN_API_KEY rejected (HTTP ${status})`));
    expect(fake.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("(c) retries a 429 on search, then returns the page", async () => {
    let n = 0;
    const fake = fakeGarmin({
      search: () => (n++ === 0 ? new Response("slow down", { status: 429, headers: { "retry-after": "3" } }) : LIST_PAGE),
    });
    const { client, sleeps } = setup(fake);
    const page = await client.searchActivities({ start: 0, limit: 99 });
    expect(page.map((i) => i.activityId)).toEqual([900000003, 900000002, 900000001]);
    expect(fake.dataCalls()).toHaveLength(2);
    expect(sleeps).toEqual([3000, 1000]); // Retry-After, then the polite pause
    const q = fake.dataCalls()[1]!.url.searchParams;
    expect(Object.fromEntries(q)).toEqual({ activityType: "cycling", limit: "99", start: "0" });
    expect(fake.dataCalls()[1]!.headers.Authorization).toBe(`Bearer ${SYNTHETIC_JWT}`);
  });

  it("passes startDate and endDate when given", async () => {
    const fake = fakeGarmin();
    const { client } = setup(fake);
    await client.searchActivities({ start: 99, startDate: "2026-05-29", endDate: "2026-06-01" });
    expect(Object.fromEntries(fake.dataCalls()[0]!.url.searchParams)).toEqual({
      activityType: "cycling",
      limit: "99",
      start: "99",
      startDate: "2026-05-29",
      endDate: "2026-06-01",
    });
  });

  it("re-exchanges once on a 401 and repeats the call", async () => {
    let n = 0;
    const fake = fakeGarmin({ detail: () => (n++ === 0 ? new Response("", { status: 401 }) : { timeZoneUnitDTO: { timeZone: "UTC" } }) });
    const { client } = setup(fake);
    const d = await client.activityDetail(900000003);
    expect(d.timeZoneUnitDTO?.timeZone).toBe("UTC");
    expect(fake.tokenCalls()).toHaveLength(2);
    expect(fake.dataCalls()).toHaveLength(2);
  });

  it("throws GarminAuthError when the fresh token is refused too", async () => {
    const fake = fakeGarmin({ detail: () => new Response("", { status: 401 }) });
    const { client } = setup(fake);
    await expect(client.activityDetail(1)).rejects.toBeInstanceOf(GarminAuthError);
    expect(fake.tokenCalls()).toHaveLength(2);
    expect(fake.dataCalls()).toHaveLength(2);
  });

  it("downloads the FIT zip as bytes with the zip Accept header", async () => {
    const fake = fakeGarmin({ fit: () => new Uint8Array([0x50, 0x4b, 3, 4]) });
    const { client } = setup(fake);
    expect(Array.from(await client.activityFitZip(5))).toEqual([0x50, 0x4b, 3, 4]);
    const call = fake.dataCalls()[0]!;
    expect(call.url.pathname).toBe("/download-service/files/activity/5");
    expect(call.headers.Accept).toBe("application/zip, application/octet-stream");
  });

  it("calls the weight range with includeAll", async () => {
    const fake = fakeGarmin();
    const { client } = setup(fake);
    await client.weightRange("2026-01-01", "2026-12-31");
    const call = fake.dataCalls()[0]!;
    expect(call.url.pathname).toBe("/weight-service/weight/range/2026-01-01/2026-12-31");
    expect(call.url.searchParams.get("includeAll")).toBe("true");
  });
});
