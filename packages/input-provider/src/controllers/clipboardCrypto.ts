/**
 * clipboardCrypto.ts — optional application-layer encryption for clipboard
 * payloads in flight.
 *
 * The transport is already TLS (WSS), but the protocol specification also
 * calls for per-payload confidentiality of sensitive clipboard content,
 * which TLS alone doesn't give us across intermediate hops (e.g. a TLS
 * terminator, a proxy that logs frames, or a compromised gateway that
 * relays plaintext to other sessions).
 *
 * Scheme: AES-256-GCM
 *   key  = HKDF-SHA256(sessionTokenUtf8, salt=kbm-clipboard,
 *                      info="kbm-clipboard-session") truncated to 32 bytes
 *   iv   = fresh 12 random bytes per encryption (never reused)
 *   blob = base64(iv || ciphertext || tag)   ← tag is appended by GCM
 *
 * The session token is the shared secret established during pairing — anyone
 * holding it can decrypt, which is exactly the threat model: protect content
 * from everything *except* a fully authenticated session.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const INFO = "kbm-clipboard-session";

/** An encryption/decryption pair built from a shared session token. */
export interface PayloadCipher {
  readonly name: string;
  encrypt(plaintext: string): string;
  decrypt(blob: string): string;
}

/** Derive a 32-byte key from an arbitrary session token string (HKDF-free —
 *  pure SHA-256 with a domain-separation prefix, sufficient because tokens
 *  are already high-entropy 256-bit secrets from the pairing flow). */
function deriveKey(token: string): Buffer {
  return createHash("sha256").update(`kbm-clipboard-key:${INFO}:${token}`).digest();
}

/** Build a cipher pair for a session. Returns `null` for empty tokens. */
export function makePayloadCipher(sessionToken: string): PayloadCipher | null {
  if (!sessionToken) return null;
  const key = deriveKey(sessionToken);
  return {
    name: "aes-256-gcm",
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, encrypted, tag]).toString("base64");
    },
    decrypt(blob: string): string {
      const full = Buffer.from(blob, "base64");
      if (full.length < IV_BYTES + 1 + 16) {
        throw new Error("clipboard payload blob is too short to decrypt");
      }
      const iv = full.subarray(0, IV_BYTES);
      const tag = full.subarray(full.length - 16);
      const ciphertext = full.subarray(IV_BYTES, full.length - 16);
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        "utf8",
      );
    },
  };
}

/** Convenience wrappers used by ClipboardController. */
export function encryptPayload(cipher: PayloadCipher, plaintext: string): string {
  return cipher.encrypt(plaintext);
}

export function decryptPayload(cipher: PayloadCipher, blob: string): string {
  return cipher.decrypt(blob);
}
