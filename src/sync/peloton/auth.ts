/**
 * Peloton auth via Auth0 refresh tokens (AI-627 payload facts 6 and 12.7: password login is dead).
 * The refresh token rotates on every use and is stored encrypted; the access token lives only in
 * memory for one run.
 */
import { fetchWithRetry, type FetchLike } from "../http.js";
import type { SyncStore } from "../store.js";
import type { StoredCredential } from "../types.js";
import { PelotonConcurrentRefresh, PelotonHttpError, PelotonReconnectRequired } from "./errors.js";
import type { SecretBox } from "./types.js";

export const PELOTON_TOKEN_URL = "https://auth.onepeloton.com/oauth/token";

export interface PelotonAuthDeps {
  fetch: FetchLike;
  /** PELOTON_AUTH0_CLIENT_ID: the `azp` claim of a Peloton access token. */
  clientId: string;
  box: SecretBox;
  store: SyncStore;
  /** PELOTON_REFRESH_TOKEN; used only while no credential row exists. */
  bootstrapRefreshToken: string | null;
  now: () => number;
  /** Backoff sleep for 429/5xx retries (default: real timers). */
  sleep?: (ms: number) => Promise<void>;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** `error` and `error_description` of an Auth0 error body, never the token. */
async function authErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown; error_description?: unknown };
    return [body.error, body.error_description].filter((v) => typeof v === "string" && v).join(": ");
  } catch {
    return "";
  }
}

/**
 * Exchanges the stored refresh token for an access token. The rotated refresh token is encrypted
 * and saved (compare-and-swap on rotated_at) before the access token is returned.
 */
export async function getPelotonAccessToken(d: PelotonAuthDeps): Promise<string> {
  const row = await d.store.getCredential("peloton");
  if (row?.revokedAt) {
    throw new PelotonReconnectRequired(`Peloton refresh token was revoked at ${row.revokedAt}; reseed a new one`);
  }
  const refreshToken = row ? await d.box.decrypt(row) : d.bootstrapRefreshToken;
  if (!refreshToken) throw new PelotonReconnectRequired("No Peloton refresh token: set PELOTON_REFRESH_TOKEN and reseed");

  const res = await fetchWithRetry(
    d.fetch,
    PELOTON_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: d.clientId, refresh_token: refreshToken }),
    },
    d.sleep ? { sleep: d.sleep } : {},
  );

  if (res.status === 200) {
    const body = (await res.json()) as TokenResponse;
    if (typeof body.access_token !== "string" || body.access_token === "") {
      throw new PelotonHttpError(200, "/oauth/token", "response has no access_token");
    }
    const nextRefresh = typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : refreshToken;
    const at = d.now();
    const expiresInS = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : null;
    const saved = await d.store.saveCredential(
      "peloton",
      {
        ...(await d.box.encrypt(nextRefresh)),
        rotatedAt: iso(at),
        accessExpiresAt: expiresInS === null ? null : iso(at + expiresInS * 1000),
        revokedAt: null,
      },
      row?.rotatedAt ?? null,
    );
    if (!saved) throw new PelotonConcurrentRefresh();
    return body.access_token;
  }

  // 429 that outlived the retries is throttling, not a rejected token.
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    const detail = await authErrorDetail(res);
    if (row) {
      const revoked: StoredCredential = { ...row, revokedAt: iso(d.now()) };
      // A lost swap means another run rotated the token after we read it: our copy was stale,
      // not revoked, so leave the fresh row alone.
      if (!(await d.store.saveCredential("peloton", revoked, row.rotatedAt))) throw new PelotonConcurrentRefresh();
    }
    const message = `Peloton refresh token rejected (HTTP ${res.status}${detail ? ` ${detail}` : ""}); reseed a new one`;
    await d.store.saveSyncState({ source: "peloton", authStatus: "reconnect_required", lastError: message });
    throw new PelotonReconnectRequired(message);
  }

  throw new PelotonHttpError(res.status, "/oauth/token");
}

/**
 * Stores `refreshToken` as the Peloton credential, overwriting any row and clearing revokedAt, and
 * marks sync_state `peloton` ok. The runner's reseed flag calls it.
 */
export async function seedPelotonCredential(
  store: SyncStore,
  box: SecretBox,
  refreshToken: string,
  now: () => number,
): Promise<void> {
  if (!refreshToken.trim()) throw new Error("seedPelotonCredential: empty refresh token");
  const row = await store.getCredential("peloton");
  const saved = await store.saveCredential(
    "peloton",
    { ...(await box.encrypt(refreshToken.trim())), rotatedAt: iso(now()), accessExpiresAt: null, revokedAt: null },
    row?.rotatedAt ?? null,
  );
  if (!saved) throw new PelotonConcurrentRefresh("Peloton credential changed while reseeding; run the reseed again");
  await store.saveSyncState({ source: "peloton", authStatus: "ok", lastError: null });
}
