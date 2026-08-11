/**
 * @kbm-remote/auth
 *
 * Pure, dependency-free cryptography — deliberately free of runtime deps so
 * it can run identically on Electron, Node, and React Native (JSC/Hermes).
 *
 *   certs/    — self-signed TLS certificate generation + SHA-256 fingerprint
 *   pairing/  — 8-char pairing code generation/validation (5-min TTL),
 *               HMAC proof-of-possession (Protocol Spec §5.3)
 *   session/  — session token issuance, SHA-256-hashed storage, revocation
 *   rbac/     — per-device permission policies + token-bucket rate limiting
 */

// Module contents introduced in M1/M3 milestones; surfaces TODO.
export const AUTH_PACKAGE_PLACEHOLDER = true;
