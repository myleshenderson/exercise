// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createNodeSecretBox, credentialsKeyId, loadCredentialsKey } from "./credentials.js";

const keyB64 = () => randomBytes(32).toString("base64");

describe("loadCredentialsKey", () => {
  it("accepts base64 of 32 bytes", () => {
    const b64 = keyB64();
    const key = loadCredentialsKey(`${b64}\n`);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
    expect(Buffer.from(key).toString("base64")).toBe(b64);
  });

  it("throws unless the value decodes to 32 bytes", () => {
    expect(() => loadCredentialsKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => loadCredentialsKey(randomBytes(33).toString("base64"))).toThrow(/32 bytes/);
    expect(() => loadCredentialsKey("")).toThrow(/CREDENTIALS_KEY/);
    expect(() => loadCredentialsKey("not base64 at all!")).toThrow(/CREDENTIALS_KEY/);
  });
});

describe("createNodeSecretBox (e)", () => {
  it("round-trips, with a 12-byte random iv, a 16-byte tag and keyId = sha256(key)[0..8]", async () => {
    const key = loadCredentialsKey(keyB64());
    const box = createNodeSecretBox(key);
    const a = await box.encrypt("refresh-token-secret");
    const b = await box.encrypt("refresh-token-secret");
    expect(Buffer.from(a.iv, "base64").length).toBe(12);
    expect(Buffer.from(a.authTag, "base64").length).toBe(16);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toContain("refresh");
    expect(a.keyId).toBe(createHash("sha256").update(key).digest("hex").slice(0, 8));
    expect(a.keyId).toBe(credentialsKeyId(key));
    expect(await box.decrypt(a)).toBe("refresh-token-secret");
    expect(await box.decrypt(b)).toBe("refresh-token-secret");
  });

  it("throws on a tampered tag or ciphertext", async () => {
    const box = createNodeSecretBox(loadCredentialsKey(keyB64()));
    const e = await box.encrypt("refresh-token-secret");
    const tag = Buffer.from(e.authTag, "base64");
    tag[0] ^= 1;
    await expect(box.decrypt({ ...e, authTag: tag.toString("base64") })).rejects.toThrow(/authentication/);
    const ct = Buffer.from(e.ciphertext, "base64");
    ct[0] ^= 1;
    await expect(box.decrypt({ ...e, ciphertext: ct.toString("base64") })).rejects.toThrow(/authentication/);
    // A truncated tag is rejected rather than accepted as a shorter GCM tag.
    await expect(box.decrypt({ ...e, authTag: tag.subarray(0, 4).toString("base64") })).rejects.toThrow(/auth tag/);
  });

  it("throws 'CREDENTIALS_KEY changed' for another key, and fails authentication if the keyId is forged", async () => {
    const e = await createNodeSecretBox(loadCredentialsKey(keyB64())).encrypt("refresh-token-secret");
    const other = createNodeSecretBox(loadCredentialsKey(keyB64()));
    await expect(other.decrypt(e)).rejects.toThrow("CREDENTIALS_KEY changed");
    const forged = { ...e, keyId: (await other.encrypt("x")).keyId };
    await expect(other.decrypt(forged)).rejects.toThrow(/authentication/);
  });
});
