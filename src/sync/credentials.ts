/// <reference types="node" />
/**
 * Node AES-256-GCM SecretBox for provider_credentials (AI-639). The only Node module of the
 * Peloton adapter: src/sync/peloton/** stays pure and takes a SecretBox.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { EncryptedSecret, SecretBox } from "./peloton/types.js";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Decodes CREDENTIALS_KEY (base64, e.g. `openssl rand -base64 32`); throws unless it is 32 bytes. */
export function loadCredentialsKey(b64: string): Uint8Array {
  const trimmed = (b64 ?? "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new Error("CREDENTIALS_KEY must be base64 of 32 random bytes (openssl rand -base64 32)");
  }
  const bytes = Buffer.from(trimmed, "base64");
  if (bytes.length !== KEY_BYTES) {
    throw new Error(`CREDENTIALS_KEY must decode to ${KEY_BYTES} bytes, not ${bytes.length}`);
  }
  return new Uint8Array(bytes);
}

/** The first 8 hex characters of SHA-256(key). */
export function credentialsKeyId(key: Uint8Array): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export function createNodeSecretBox(key: Uint8Array): SecretBox {
  if (key.length !== KEY_BYTES) throw new Error(`credentials key must be ${KEY_BYTES} bytes, not ${key.length}`);
  const keyBytes = Buffer.from(key);
  const keyId = credentialsKeyId(keyBytes);

  return {
    async encrypt(plain: string): Promise<EncryptedSecret> {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", keyBytes, iv, { authTagLength: TAG_BYTES });
      const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return {
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        keyId,
      };
    },

    async decrypt(e: EncryptedSecret): Promise<string> {
      if (e.keyId !== keyId) {
        throw new Error(`CREDENTIALS_KEY changed: the secret was encrypted with key ${e.keyId}, the current key is ${keyId}`);
      }
      const iv = Buffer.from(e.iv, "base64");
      const tag = Buffer.from(e.authTag, "base64");
      if (iv.length !== IV_BYTES) throw new Error(`encrypted secret has a ${iv.length}-byte iv, expected ${IV_BYTES}`);
      // GCM accepts truncated tags unless told otherwise; insist on the full 16 bytes.
      if (tag.length !== TAG_BYTES) throw new Error(`encrypted secret has a ${tag.length}-byte auth tag, expected ${TAG_BYTES}`);
      const decipher = createDecipheriv("aes-256-gcm", keyBytes, iv, { authTagLength: TAG_BYTES });
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(Buffer.from(e.ciphertext, "base64")), decipher.final()]).toString("utf8");
      } catch {
        throw new Error("encrypted secret failed authentication (tampered, or encrypted with another key)");
      }
    },
  };
}
