/**
 * Server-side transport to the app's own tables, for code that runs in the
 * app server rather than the browser (the MCP tool handlers behind `/mcp`).
 *
 * `Transport` is the shape AI-591's row client (`src/data/starkeep/rows.ts`)
 * takes: a data-server path such as `/app-data/db/programs?where=…` plus a
 * `RequestInit`. The browser's transport sends it through the signing proxy;
 * this one signs it here with the app's HMAC credential (`signedFetch`) and, in
 * the cloud, forwards the outside client's delegation token beside the
 * signature. The cloud data plane scopes every row to the delegation's user
 * and applies its mode (`read` or `readwrite`) and revocation to each call;
 * locally the HMAC alone is enough and no delegation is sent.
 *
 * Build one per request: the delegation token is per request, and a transport
 * must never be shared between two callers.
 */

import { loadAppCredentials, signedFetch } from "@starkeep/app-client";
import manifest from "../starkeep.manifest.json" with { type: "json" };

export type Transport = (path: string, init: RequestInit) => Promise<Response>;

export interface ServerTransportOptions {
  /**
   * The outside client's delegation token (`DelegatedPrincipal.token` from
   * `verifyDelegation`). Cloud only; null or omitted locally.
   */
  delegation?: string | null;
}

/** Thrown when the app has no credential (not installed, or SSM has none). */
export class MissingCredentialsError extends Error {
  constructor(appId: string) {
    super(`${appId} has no app credential; install it from admin-web first`);
    this.name = "MissingCredentialsError";
  }
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function createServerTransport(opts: ServerTransportOptions = {}): Transport {
  return async (path, init) => {
    const creds = await loadAppCredentials(manifest.id);
    if (!creds) throw new MissingCredentialsError(manifest.id);

    const headers = headerRecord(init.headers);
    const body = init.body ?? undefined;
    if (body !== undefined && typeof body !== "string") {
      throw new TypeError("server transport only sends string bodies");
    }
    if (body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";

    return signedFetch(creds, path, {
      method: init.method ?? "GET",
      headers,
      body,
      delegation: opts.delegation ?? null,
    });
  };
}
