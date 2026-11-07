/**
 * The MCP bearer token: `exr_` + base64url(AES-256-GCM sealed JSON).
 *
 * The token carries everything `/mcp` needs to act for the person who minted
 * it, so the server stores none of it:
 *
 *   plaintext = { v: 1, id: <mcp_tokens.id>, rt: <Cognito refresh token | null>, sub: <user sub | null> }
 *
 * Key = HKDF-SHA256(ikm = the app's HMAC secret, salt = empty,
 * info = "exercise-mcp-token-v1", 32 bytes). The HMAC secret is the one
 * secret the server already holds on both surfaces (a file locally, SSM in the
 * cloud), so there is no new secret to provision, and rotating it on reinstall
 * invalidates every outstanding token.
 *
 * Wire layout of the sealed blob: 12-byte IV | ciphertext | 16-byte GCM tag.
 * GCM authenticates the whole thing, so any tampering, a wrong key, or a
 * truncated blob fails to unseal; {@link unsealToken} returns null for every
 * failure rather than throwing, and never says which check failed.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

export const TOKEN_PREFIX = "exr_";
export const TOKEN_KEY_INFO = "exercise-mcp-token-v1";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface TokenPayload {
  v: 1;
  /** `mcp_tokens.id`: a UUID. */
  id: string;
  /** The creating user's Cognito refresh token (cloud), or null (local). */
  rt: string | null;
  /** The creating user's Cognito `sub` (cloud), or null (local). */
  sub: string | null;
}

export function deriveTokenKey(hmacSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", hmacSecret, Buffer.alloc(0), TOKEN_KEY_INFO, 32));
}

/** What goes into `mcp_tokens.token_hash`: lowercase hex SHA-256 of the token id. */
export function tokenIdHash(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

export function sealToken(payload: TokenPayload, hmacSecret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveTokenKey(hmacSecret), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const sealed = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return TOKEN_PREFIX + sealed.toString("base64url");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

function asPayload(value: unknown): TokenPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (typeof p.id !== "string" || p.id.length === 0) return null;
  if (!isNullableString(p.rt) || !isNullableString(p.sub)) return null;
  return { v: 1, id: p.id, rt: p.rt, sub: p.sub };
}

/** The payload of a token this server sealed, or null for anything else. */
export function unsealToken(token: string, hmacSecret: string): TokenPayload | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const encoded = token.slice(TOKEN_PREFIX.length);
  // Node's base64url decoder skips characters outside the alphabet instead of
  // failing, so check the alphabet first.
  if (!BASE64URL.test(encoded)) return null;
  const blob = Buffer.from(encoded, "base64url");
  if (blob.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(blob.length - TAG_BYTES);
    const ciphertext = blob.subarray(IV_BYTES, blob.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", deriveTokenKey(hmacSecret), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return asPayload(JSON.parse(plaintext.toString("utf8")));
  } catch {
    return null;
  }
}
