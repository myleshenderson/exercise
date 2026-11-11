import { describe, expect, it } from "vitest";
import type { SyncStore } from "../store.js";
import { createMemorySyncStore } from "../testing/memoryStore.js";
import type { StoredCredential } from "../types.js";
import {
  auth0InvalidGrant,
  auth0WithRefresh,
  auth0WithoutRefresh,
  fakeFetch,
  jsonResponse,
  pelotonApi,
} from "./__fixtures__/peloton.js";
import { PELOTON_TOKEN_URL, getPelotonAccessToken, seedPelotonCredential } from "./auth.js";
import { createPelotonClient } from "./client.js";
import { PelotonConcurrentRefresh, PelotonReconnectRequired } from "./errors.js";
import type { SecretBox } from "./types.js";

/** A reversible stand-in for the Node box (credentials.test.ts covers the real cipher). */
const fakeBox: SecretBox = {
  async encrypt(plain) {
    return { ciphertext: `enc(${plain})`, iv: "iv", authTag: "tag", keyId: "k1" };
  },
  async decrypt(e) {
    const m = /^enc\((.*)\)$/.exec(e.ciphertext);
    if (!m || e.keyId !== "k1") throw new Error("CREDENTIALS_KEY changed");
    return m[1];
  },
};

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const now = () => NOW;
const noSleep = async () => {};

async function storedRow(token: string, rotatedAt: string | null, revokedAt: string | null = null): Promise<StoredCredential> {
  return { ...(await fakeBox.encrypt(token)), accessExpiresAt: null, rotatedAt, revokedAt };
}

const tokenBody = (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, string>;

/** Records the order of credential saves and fetches in one shared log. */
function logged(store: SyncStore, log: string[]): SyncStore {
  return {
    ...store,
    async saveCredential(p, c, expected) {
      const ok = await store.saveCredential(p, c, expected);
      log.push(`saveCredential:${ok}`);
      return ok;
    },
  };
}

describe("getPelotonAccessToken", () => {
  it("(a) saves the rotated refresh token before the first API request", async () => {
    const log: string[] = [];
    const store = createMemorySyncStore("owner", { credential: await storedRow("refresh-token-1", "2026-11-10T00:00:00.000Z") });
    const route = pelotonApi();
    const { fetch, calls } = fakeFetch((url) => {
      log.push(`fetch:${new URL(url).host}${new URL(url).pathname}`);
      return url === PELOTON_TOKEN_URL ? jsonResponse(auth0WithRefresh) : route(url);
    });
    const deps = { fetch, clientId: "client-x", box: fakeBox, store: logged(store, log), bootstrapRefreshToken: null, now };
    const client = createPelotonClient({ fetch, getToken: () => getPelotonAccessToken(deps), sleep: noSleep });

    await client.me();

    expect(log).toEqual(["fetch:auth.onepeloton.com/oauth/token", "saveCredential:true", "fetch:api.onepeloton.com/api/me"]);
    expect(calls[0].init?.method).toBe("POST");
    expect(tokenBody(calls[0].init)).toEqual({ grant_type: "refresh_token", client_id: "client-x", refresh_token: "refresh-token-1" });
    const headers = calls[1].init?.headers as Record<string, string>;
    expect(headers).toEqual({ Authorization: "Bearer access-token-1", "peloton-platform": "web", Accept: "application/json" });
    expect(store.state.credential).toEqual({
      ...(await fakeBox.encrypt("refresh-token-2")),
      rotatedAt: "2026-11-11T12:00:00.000Z",
      accessExpiresAt: "2026-11-13T12:00:00.000Z",
      revokedAt: null,
    });
    // The access token is never stored.
    expect(JSON.stringify(store.state)).not.toContain("access-token-1");
  });

  it("uses the bootstrap token when no row exists, and the stored row over the bootstrap", async () => {
    const store = createMemorySyncStore("owner");
    const { fetch, calls } = fakeFetch(() => jsonResponse(auth0WithRefresh));
    const deps = { fetch, clientId: "c", box: fakeBox, store, bootstrapRefreshToken: "bootstrap-token", now };
    expect(await getPelotonAccessToken(deps)).toBe("access-token-1");
    expect(tokenBody(calls[0].init).refresh_token).toBe("bootstrap-token");
    expect(await fakeBox.decrypt(store.state.credential!)).toBe("refresh-token-2");

    await getPelotonAccessToken(deps);
    expect(tokenBody(calls[1].init).refresh_token).toBe("refresh-token-2");
  });

  it("(b) keeps the old refresh token when the response has none", async () => {
    const store = createMemorySyncStore("owner", { credential: await storedRow("refresh-token-1", null) });
    const { fetch } = fakeFetch(() => jsonResponse(auth0WithoutRefresh));
    await getPelotonAccessToken({ fetch, clientId: "c", box: fakeBox, store, bootstrapRefreshToken: "ignored", now });
    expect(await fakeBox.decrypt(store.state.credential!)).toBe("refresh-token-1");
    expect(store.state.credential?.rotatedAt).toBe("2026-11-11T12:00:00.000Z");
  });

  it("(c) 400 invalid_grant sets revoked_at and reconnect_required, then throws", async () => {
    const store = createMemorySyncStore("owner", { credential: await storedRow("refresh-token-1", "2026-11-10T00:00:00.000Z") });
    const { fetch, calls } = fakeFetch(() => jsonResponse(auth0InvalidGrant, 400));
    const deps = { fetch, clientId: "c", box: fakeBox, store, bootstrapRefreshToken: null, now, sleep: noSleep };
    await expect(getPelotonAccessToken(deps)).rejects.toBeInstanceOf(PelotonReconnectRequired);
    expect(calls).toHaveLength(1); // 4xx is not retried
    expect(store.state.credential?.revokedAt).toBe("2026-11-11T12:00:00.000Z");
    const state = await store.getSyncState("peloton");
    expect(state?.authStatus).toBe("reconnect_required");
    expect(state?.lastError).toMatch(/400 invalid_grant/);
    expect(state?.lastError).not.toContain("refresh-token-1");

    // A revoked row throws without calling Auth0.
    await expect(getPelotonAccessToken(deps)).rejects.toBeInstanceOf(PelotonReconnectRequired);
    expect(calls).toHaveLength(1);
  });

  it("retries 5xx, and throws reconnect when there is no token at all", async () => {
    const store = createMemorySyncStore("owner");
    let n = 0;
    const { fetch, calls } = fakeFetch(() => (++n === 1 ? new Response("down", { status: 503 }) : jsonResponse(auth0WithRefresh)));
    await getPelotonAccessToken({ fetch, clientId: "c", box: fakeBox, store, bootstrapRefreshToken: "b", now, sleep: noSleep });
    expect(calls).toHaveLength(2);

    const empty = createMemorySyncStore("owner");
    await expect(
      getPelotonAccessToken({ fetch, clientId: "c", box: fakeBox, store: empty, bootstrapRefreshToken: null, now }),
    ).rejects.toBeInstanceOf(PelotonReconnectRequired);
  });

  it("(d) a lost compare-and-swap throws PelotonConcurrentRefresh and the client makes no API call", async () => {
    const base = createMemorySyncStore("owner", { credential: await storedRow("refresh-token-1", "2026-11-10T00:00:00.000Z") });
    // Another run rotates the token between our read and our write.
    const racing: SyncStore = {
      ...base,
      async getCredential(p) {
        const row = await base.getCredential(p);
        base.state.credential = { ...base.state.credential!, rotatedAt: "2026-11-11T11:59:59.000Z" };
        return row;
      },
    };
    const route = pelotonApi();
    const { fetch, calls } = fakeFetch((url) => (url === PELOTON_TOKEN_URL ? jsonResponse(auth0WithRefresh) : route(url)));
    const deps = { fetch, clientId: "c", box: fakeBox, store: racing, bootstrapRefreshToken: null, now };
    const client = createPelotonClient({ fetch, getToken: () => getPelotonAccessToken(deps), sleep: noSleep });

    await expect(client.me()).rejects.toBeInstanceOf(PelotonConcurrentRefresh);
    expect(calls.map((c) => c.url)).toEqual([PELOTON_TOKEN_URL]);
    expect(base.state.credential?.rotatedAt).toBe("2026-11-11T11:59:59.000Z");
  });
});

describe("seedPelotonCredential", () => {
  it("overwrites a revoked row, clears revokedAt and sets auth_status ok", async () => {
    const store = createMemorySyncStore("owner", {
      credential: await storedRow("old", "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z"),
      syncState: [
        {
          source: "peloton",
          cursor: null,
          lastRunAt: null,
          lastSuccessAt: null,
          itemsFetched: 0,
          itemsUpserted: 0,
          lastError: "rejected",
          backfillComplete: true,
          authStatus: "reconnect_required",
        },
      ],
    });
    await seedPelotonCredential(store, fakeBox, "pasted-token", now);
    expect(store.state.credential?.revokedAt).toBeNull();
    expect(await fakeBox.decrypt(store.state.credential!)).toBe("pasted-token");
    const state = await store.getSyncState("peloton");
    expect(state?.authStatus).toBe("ok");
    expect(state?.lastError).toBeNull();
    expect(state?.backfillComplete).toBe(true);
  });
});
