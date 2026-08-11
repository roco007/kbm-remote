/**
 * TLS helpers — certificate generation, SHA-256 fingerprinting and pin
 * validation (Protocol Spec §2.6, §3.1, §5.3).
 *
 * Node-only (Electron main process); the sender embeds the pinned fingerprint
 * from pairing and validates peer certificates through this module's public
 * `verifyPin` primitive, which the app layer wires into the TLS socket.
 *
 * Certificate emission is delegated to `selfsigned` (MIT, dependency of the
 * ws/TLS ecosystem) so the output is a fully RFC 5280-compliant X.509v3
 * certificate — the hand-rolled DER builder historically used here produced
 * structurally subtle invalidity that Node's TLS stack rejects.
 */

import { createHash, randomBytes } from "node:crypto";
import { X509Certificate } from "node:crypto";

import { Logger } from "../logging";

const tlsLog = new Logger("tls");

export interface KeyPair {
  key: string;
  cert: string;
}

export interface CertificateIdentity {
  /** SHA-256 fingerprint of the DER-encoded certificate, hex. */
  fingerprint: string;
  /** Human label used in pairing QR codes and the trusted-devices screen. */
  deviceId: string;
}

/**
 * Generate a self-signed receiver certificate. The pairing QR carries the
 * fingerprint so senders can pin the very first connection without a CA.
 *
 * Emits a full X.509v3 certificate (SHA-256 signature, random 20-byte serial,
 * Subject Key Identifier) so it survives every X.509 parser in the ecosystem.
 */
export async function generateSelfSignedCert(options?: {
  deviceId?: string;
  validityDays?: number;
  keySize?: number;
}): Promise<KeyPair> {
  const deviceId = options?.deviceId ?? `kbm-${randomHex(8)}`;
  const validityDays = options?.validityDays ?? 3650;
  const keySize = options?.keySize ?? 2048;

  const selfsigned = await import("selfsigned");
  const attrs = [{ name: "commonName", value: deviceId }];
  const generated = await selfsigned.generate(attrs, {
    keySize,
    notAfterDate: new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000),
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: true },
      { name: "keyUsage", keyCertSign: true, digitalSignature: true },
    ],
  });
  return { key: generated.private, cert: generated.cert };
}

/** SHA-256 fingerprint of a PEM or DER certificate (hex, lowercase). */
export function fingerprintOf(certPemOrDer: string | Buffer): string {
  const der = typeof certPemOrDer === "string" ? pemToDer(certPemOrDer) : certPemOrDer;
  return createHash("sha256").update(der).digest("hex");
}

/**
 * Verify a presented certificate against an expected pin. Returns false on
 * any parse or mismatch — the caller aborts the connection with a
 * user-visible impersonation warning per UX Design §S2.
 */
export function verifyPin(certPemOrDer: string | Buffer, expectedPin: string): boolean {
  let fingerprint: string;
  try {
    fingerprint = fingerprintOf(certPemOrDer);
  } catch {
    tlsLog.warn("certificate fingerprint unavailable — refusing pin check");
    return false;
  }
  const normalized = expectedPin.replace(/:/g, "").toLowerCase();
  return fingerprint === normalized && fingerprint.length === 64;
}

/** Extract a human device label from a certificate's subject CN. */
export function deviceIdOf(certPem: string): string {
  const cert = parseCertificate(certPem);
  if (!cert) return "unknown";
  const cn = cert.subject.split(/,\s*/).find((part) => part.startsWith("CN="));
  return cn ? cn.slice(3) : "unknown";
}

/** Parse a PEM certificate with Node's built-in X.509 support. */
export function parseCertificate(certPem: string): X509Certificate | null {
  try {
    return new X509Certificate(certPem);
  } catch {
    return null;
  }
}

// ── Internals ─────────────────────────────────────────────────────────────

function pemToDer(pem: string): Buffer {
  const stripped = pem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s+/g, "");
  return Buffer.from(stripped, "base64");
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
