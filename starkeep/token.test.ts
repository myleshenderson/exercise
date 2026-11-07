// @vitest-environment node
import { describe, expect, it } from "vitest";
import { deriveTokenKey, sealToken, TOKEN_PREFIX, tokenIdHash, unsealToken, type TokenPayload } from "./token.js";

const SECRET = "app-hmac-secret";
const payload: TokenPayload = { v: 1, id: "3f0c1e9a-1111-4222-8333-444455556666", rt: "refresh-token", sub: "user-sub" };

function flipByte(token: string, index: number): string {
  const blob = Buffer.from(token.slice(TOKEN_PREFIX.length), "base64url");
  blob[index] = blob[index]! ^ 0x01;
  return TOKEN_PREFIX + blob.toString("base64url");
}

describe("sealed MCP token", () => {
  it("round-trips a cloud payload and a local (null) payload", () => {
    const token = sealToken(payload, SECRET);
    expect(token.startsWith("exr_")).toBe(true);
    expect(token.slice(4)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(unsealToken(token, SECRET)).toEqual(payload);

    const local: TokenPayload = { v: 1, id: payload.id, rt: null, sub: null };
    expect(unsealToken(sealToken(local, SECRET), SECRET)).toEqual(local);
  });

  it("does not carry the refresh token in the clear", () => {
    const token = sealToken(payload, SECRET);
    expect(token).not.toContain("refresh-token");
    expect(Buffer.from(token.slice(4), "base64url").toString("latin1")).not.toContain("refresh-token");
  });

  it("uses a fresh IV per seal", () => {
    expect(sealToken(payload, SECRET)).not.toBe(sealToken(payload, SECRET));
  });

  it("rejects tampered ciphertext, IV and tag", () => {
    const token = sealToken(payload, SECRET);
    const len = Buffer.from(token.slice(4), "base64url").length;
    for (const i of [0, 12, Math.floor(len / 2), len - 1]) {
      expect(unsealToken(flipByte(token, i), SECRET)).toBeNull();
    }
  });

  it("rejects a token sealed under another key", () => {
    expect(unsealToken(sealToken(payload, "another-secret"), SECRET)).toBeNull();
  });

  it("rejects a token without the exr_ prefix", () => {
    const token = sealToken(payload, SECRET);
    expect(unsealToken(token.slice(4), SECRET)).toBeNull();
    expect(unsealToken("xyz_" + token.slice(4), SECRET)).toBeNull();
  });

  it("rejects malformed base64 and short blobs", () => {
    const token = sealToken(payload, SECRET);
    expect(unsealToken(token.slice(0, 20) + "!" + token.slice(21), SECRET)).toBeNull();
    expect(unsealToken(token + "=", SECRET)).toBeNull();
    expect(unsealToken("exr_", SECRET)).toBeNull();
    expect(unsealToken("exr_AAAA", SECRET)).toBeNull();
    expect(unsealToken("exr_" + token.slice(4, 30), SECRET)).toBeNull();
  });

  it("rejects a well-sealed plaintext that is not a v1 payload", () => {
    const bad = sealToken({ v: 2, id: "x", rt: null, sub: null } as unknown as TokenPayload, SECRET);
    expect(unsealToken(bad, SECRET)).toBeNull();
  });

  it("derives a 32-byte key per secret and hashes ids as hex sha256", () => {
    expect(deriveTokenKey(SECRET)).toHaveLength(32);
    expect(deriveTokenKey(SECRET).equals(deriveTokenKey("other"))).toBe(false);
    expect(tokenIdHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
