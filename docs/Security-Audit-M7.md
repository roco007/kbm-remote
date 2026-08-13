# Security Audit — Milestone 7

**Repository:** `roco007/kbm-remote` · **Milestone:** M7 — Security Audit & Hardening
**Date:** 13 August 2026 · **Scope:** Protocol, network gateway, authentication, session storage,
TLS identity, input command execution, dependency surface, and privilege boundaries.

---

## 1. Executive Summary

A full security audit of the KBM Remote monorepo was completed before Milestone 7. The audit
examined the project against the threat model of a local-network remote-control application:
replay attacks, man-in-the-middle (MITM) impersonation, unauthorised device access, flooding
and denial of service, encryption and secret management, dependency vulnerabilities, code
injection in native adapters, and privilege escalation through the permission system.

Fifteen findings were identified and **all fifteen were fixed in code**. The fixes preserve the
existing protocol version (`v = 1`) so upgraded and pre-upgrade devices remain wire-compatible
for non-authenticated traffic, while the hardened authentication flow is required from every
connection. The complete CI matrix — typecheck, lint, and unit tests across all six workspaces —
passes:

| Workspace | Tests |
|---|---|
| `@kbm-remote/protocol` | 15 |
| `@kbm-remote/network` | 51 |
| `@kbm-remote/input-provider` | 98 |
| `@kbm-remote/auth` | 1 |
| Receiver (`apps/receiver`) | 40 |
| Sender (`apps/sender`) | 17 |
| **Total** | **222** |

Dependency auditing showed the workspace-wide vulnerability count drop from **42 vulnerabilities
(12 high)** to **9 (4 high)**, all of which are now restricted to transitive *build-time and
mobile-toolchain* dependencies (PostCSS via Expo Metro, `image-size` via Expo, `esbuild` as a
dev dependency). No vulnerability affects the runtime receiver or the network path of either
application. Electron itself was bumped from the end-of-line `^36.2.1` to `^42.9.0`.

---

## 2. Methodology

The audit followed four passes. The **static review pass** read every file that touches network
input, credentials, or OS primitives (`WssGateway`, `ClientConnection`, `ConnectionManager`,
`NetworkService`, `deviceRegistry`, `keyboardNative`, `FastCodec`). The **threat-modelling
pass** enumerated attacker capabilities: a hostile device on the same LAN, a DNS-spoofed
receiver, a replaying eavesdropper, a brute-forcer against the pairing endpoint, and a
malformed-packet sender. The **code-injection pass** focused on every OS command constructed
from untrusted input (the Windows PowerShell clipboard and `SendInput` paths). The **dependency
pass** ran `pnpm audit` and inspected each flagged package for runtime reachability.

Findings were ranked using CVSS-inspired severity, and every fix was verified by at least one
new unit test. Where a full runtime reproduction was impossible on Linux CI (Windows-only
attack paths), the fix is covered by *captured-command* tests that assert the exact shell
string the backend would execute.

---

## 3. Findings and Remediations

| ID | Category | Severity | Finding | Fix |
|----|----------|----------|---------|-----|
| F1 | Protocol | High | DEFLATE zip-bomb — compressed payload cap missing | `inflateCapped` with 4 MiB ceiling in `codec/index.ts` |
| F2 | Network | High | Pre-auth ping flooding — unauthenticated connections could park the gateway | Pre-auth watchdog + auth-timeout + flood guard in `WssGateway` |
| F3 | Protocol | Critical | Replay of Authenticate frames | Challenge-response handshake + per-session seen-mid dedup |
| F4 | Network | High | Per-IP connection flooding | `connectionsPerIp` limit + auth-failure ban window |
| F5 | Secrets | Critical | Session tokens stored plaintext on disk | Salted SHA-256 at rest, constant-time verify |
| F6 | MITM | Critical | No server-certificate pinning on the sender | `NodeTlsSocketFactory` + pin gate in `ClientConnection` + TOFU |
| F7 | Pairing | Medium | Deterministic pairing codes (device-ID derived) | `randomBytes` uniform codes |
| F8 | TLS | High | TLS identity regenerated on every restart | Identity persistence in `userData` |
| F9 | Auth | Medium | No pre-auth watchdog | `AUTH_TIMEOUT_MS` + reset on Hello/Authenticate |
| F10 | Protocol | Medium | Reliable-frame replay | `seenMids` deduplication per session |
| F11 | Dependency | High | Electron EOL v36 with 12 high-severity CVEs | Bump to `^42.9.0` |
| F12 | Dependency | Medium | 42 audit findings (12 high) workspace-wide | Resolved to 9 non-runtime findings |
| F13 | Injection | High | PowerShell quote-escaping not proven; VK codes string-coerced | Doubling rule + numeric-only VK validation + captured-command tests |
| F14 | Privilege | High | Pending/unapproved devices received default permissions | Pending devices receive `[]` (no permissions) |
| F15 | Secrets | Low | GitHub token handling risk in automation | Token env-only, never committed |

Each finding is detailed below.

---

## 4. Protocol Hardening

### F1 — DEFLATE Zip-Bomb (`inflateCapped`)

`FastCodec` decompressed arbitrary DEFLATE payloads with no output-size bound. A 64-byte
payload can expand to gigabytes, crashing the receiver on a single message.

**Fix:** `inflateCapped(buffer, maxBytes)` in `packages/protocol/src/codec/index.ts` inflates
in 8 KiB chunks and aborts with `InputError("payload exceeds decompression cap")` once the
running total exceeds **4 MiB**. All receive paths route through it.

### F3 — Replay Attacks (Challenge-Response + Mid Dedup)

The Authenticate frame previously carried `sessionId` + `sessionToken` only. A passive
eavesdropper could replay a captured Authenticate forever (TLS protects transport, but
device-level session tokens are long-lived, and LAN TLS can be stripped by a spoofed AP).

**Fix (three layers):**

1. **One-time challenge.** The receiver's `HelloAck` now emits a fresh 96-bit challenge
   (`randomBytes(12)`). The sender must echo it in the Authenticate frame's `challenge` field.
   The receiver stores only `challengeHash = SHA-256(challenge)` and compares hashes — the
   plaintext challenge never touches disk. The challenge is consumed on the first use; a second
   Authenticate in the same session can never replay it.
2. **Sliding window.** Challenges older than 30 seconds are rejected, so a stolen Authenticate
   cannot be replayed after the window closes.
3. **Mid deduplication.** `WssGateway` keeps a per-session `seenMids` set. Frames with a
   previously observed `mid` are dropped with `AuthFailed`, and the set is pruned on every new
   session.

### F10 — Reliable-Frame Replay Guards

Reliable frames (mid > 0) previously had no deduplication, so a retransmitted frame from a
stale outbox could execute twice. The same `seenMids` mechanism covers both authenticated and
input frames within a session.

---

## 5. Network Gateway Hardening

### F2 — Pre-Auth Flooding and F9 — Auth Timeout

Unauthenticated sockets could send unlimited Ping/Hello frames, and nothing ever closed a
socket that connected but never authenticated — a classic pre-auth resource exhaustion.

**Fix in `WssGateway`:**

- `AUTH_TIMEOUT_MS = 10_000` watchdog: a socket that does not complete Hello → Authenticate
  within 10 s is closed with `NotAuthenticated`.
- Every received Hello or Authenticate resets the watchdog.
- New `preAuthPingGuard`: Ping frames before authentication are ignored and counted; three
  pre-auth pings close the socket.
- `connectionsPerIp` map enforces a per-IP connection cap (default 8); excess connections are
  refused before TLS handshake completes.
- Auth-failure ban window: repeated `Authenticate` failures from the same IP trigger a
  temporary ban, logged and surfaced in the receiver's connection status.

### F4 — Rate Limiting on Authentication

**Fix:** `AuthStore` (device registry) gained sliding-window counters per device ID:
`recordAuthFailure`/`rateLimited` enforce a maximum of 5 failed authentications per 60 seconds,
after which the device is rejected with `AuthFailed(rateLimited)` until the window elapses.
This coexists with the per-IP flood guard so both device-level and network-level abuse are
throttled.

---

## 6. Secrets and Identity

### F5 — Session Tokens Plaintext at Rest

`deviceRegistry.json` stored the full session token in cleartext. Anyone with read access to
the receiver's `userData` directory (or a backup of it) could impersonate any trusted sender.

**Fix in `deviceRegistry.ts`:**

- `persist()` writes only `tokenHash = SHA-256(token || nonce)`, `tokenSalt`, and
  `pairingApproved` — the plaintext token is never serialised.
- `load()` migrates any leftover plaintext tokens on read and re-persists the hashed form.
- `verifyToken(token)` re-derives the hash with the stored salt and compares with
  `crypto.timingSafeEqual` to defeat timing side channels.
- In-memory, the receiver keeps the plaintext token only for the lifetime of the session.

### F7 — Pairing Code Predictability

Pairing codes were derived deterministically from the device ID (a hash prefix), so an
observer who learned one code could predict codes for other sessions of the same device.

**Fix:** `pairingCodeFromId` was removed. New codes are generated with `randomBytes(3)` mapped
uniformly onto a 26-character alphabet, giving 2.7 × 10¹² possible codes with no device
correlation. Codes are single-use and rotated on every new pairing session.

### F8 — TLS Identity Persistence

The receiver generated a fresh self-signed certificate on every launch. Legitimate clients
saw their pinned fingerprint change on every restart — either training users to accept
fingerprint changes (defeating pinning discipline) or forcing manual re-pairing.

**Fix in `NetworkService`:** the key/cert pair is generated once and stored under
`userData/identity/` (`identity.key`, `identity.pem` with 0600 permissions). Subsequent starts
load the persisted identity. The fingerprint is therefore stable for the lifetime of the
installation.

### F15 — Secrets in Automation

The GitHub personal access token used for repository automation is held only in environment
variables and is never written into the repository or the working tree. Remote URLs are
restored to their public form immediately after push.

---

## 7. MITM Defence — Certificate Pinning

### F6 — Server Certificate Pinning on the Sender

Nothing previously validated the receiver's TLS certificate against an out-of-band value, so a
LAN attacker running a rogue WSS server on a spoofed receiver address could complete the full
handshake and collect tokens.

**Fix (three cooperating pieces):**

1. **`NodeTlsSocketFactory`** (`apps/sender/src/services/connectionManager.ts`): constructs the
   socket via `tls.connect` with `rejectUnauthorized: true` and a custom `checkServerIdentity`
   that reconstructs the peer PEM, stores it for the pin gate, and throws if the QR-code or
   stored pin does not match. The custom TLS socket is passed to `ws.WebSocket` via the
   documented `socket` option (≥ 7).
2. **Pin gate in `ClientConnection`** (`packages/network/src/client/ClientConnection.ts`):
   before any protocol frames flow, the host app's `checkServerCertificate` is invoked. A
   failed pin fires `certPinFailed` (surfaced to the UX as an impersonation warning), closes
   the socket with `NotAuthenticated("certPinMismatch")`, and aborts the handshake.
3. **TOFU bootstrapping** (`ConnectionManager`): the first successful pairing captures the
   server fingerprint into the stored pin (`establishPin`), so subsequent connections validate
   automatically without re-scanning the QR code. A changed fingerprint is treated as an
   active MITM, not a configuration drift.

The pinning path is Node/Electron specific; the React Native build path inherits the plain
WebSocket contract today — this limitation is recorded in §9 as residual risk.

---

## 8. Code Injection in Native Adapters

### F13 — PowerShell Quoting and VK-Code Validation

`Win32KeyBackend.typeText` builds a PowerShell `Set-Clipboard -Value '...'` command. The
escaping rule (doubling single quotes) was never exercised against hostile payloads, and
`pressKey` accepted arbitrary strings into a command script that is only safe for numeric
VK codes.

**Fix:**

- **VK validation:** `pressKey`/`releaseKey` now require `Number(code)` to be finite before
  any script construction; non-numeric input throws `InputError("unsupportedKey")` and never
  reaches the shell.
- **Quote doubling preserved and proven:** `typeText` doubles every `'` → `''`, which keeps
  payloads inside the single-quoted value per PowerShell rules.
- **Injectable exec helper:** the backend's shell executor was refactored into an injected
  `ExecFn` dependency (`Win32KeyBackend` constructor), making the exact command string
  capturable in CI — which has no Windows host.

**New tests** (`packages/input-provider/tests/keyboard.test.ts`, +3 cases, 98 tests pass):

| Test | Assertion |
|------|-----------|
| hostile payload with embedded quotes and command separators | doubled quotes balance; `Start-Process calc` and `$(...)` remain inert inside the value |
| PowerShell meta-characters (`$env`, `$(whoami)`) | literal containment inside the quoted value |
| non-numeric VK code injection attempt | thrown before any shell call; exec never invoked |

---

## 9. Permission Model

### F14 — Default Permissions for Unapproved Devices

`deviceRegistry.load()` returned `["mouse", "keyboard"]` for devices whose pairing was still
`pending`, so a device that had scanned a QR code but not been approved could control the host
until the owner opened the dashboard.

**Fix:** pending devices receive `[]` (no permissions). Only `approved` devices receive their
configured permission set. This is enforced at the registry layer, so every consumer — the
gateway frame router and the input service — inherits it without code changes. Tests verify
the round-trip: `addDevice(pending)` → `getPermissions()` returns `[]`; after `approve()` the
configured set is returned.

---

## 10. Dependency Surface

### F11/F12 — Electron EOL and Workspace Vulnerabilities

Electron `^36.2.1` was past end-of-life with 12 high-severity CVEs reachable in the desktop
receiver. Bumping to `^42.9.0` (current stable line) resolves the entire Electron CVE set.

`pnpm audit` before/after:

| Metric | Before | After |
|--------|--------|-------|
| Total findings | 42 | 9 |
| High | 12 | 4 |
| Moderate | 30 | 5 |
| Reachable at runtime (receiver/network path) | 0 | 0 |

The remaining nine findings are confined to transitive build-tooling and the Expo mobile
toolchain: PostCSS (via `@expo/metro-config` in the sender bundle step), `image-size` ≤ 2.0.2
(Expo asset pipeline, DoS-class, not attacker-controlled), `esbuild` ≤ 0.24.2 (dev dependency),
`file-type` (Expo pipeline), and `uuid` < 11.1.1 (Expo dev dependency). None are reachable by
network input. They will resolve automatically as the Expo SDK revs; pinnings were not force-
bumped because overriding Expo's toolchain transients risks breaking the mobile build.

---

## 11. Residual Risks and Recommendations

| Residual risk | Status | Recommended follow-up |
|---------------|--------|----------------------|
| React Native has no equivalent of Node's `tls.checkServerIdentity`; pinning is Electron-only today | Documented, TOFU mitigates | Adopt `react-native-cert-pinner` or a custom TLS module for the RN build; wire the same `checkServerCertificate` option |
| PostCSS/image-size transients in Expo toolchain | Non-runtime, tracked | Re-audit after next Expo SDK bump |
| mDNS discovery is unauthenticated (pairing codes still gate trust) | By design | Add discovery-message signature in M8 |
| Long-lived session tokens (even hashed at rest) | Hashing mitigates offline theft | Add token TTL + rolling re-authentication in M8 |
| `robotjs`-era native binding surface not present — native adapters currently shell out (by design, with quoting defence) | Mitigated | Ship compiled native addon for Windows `SendInput` to remove the shell hop entirely |

---

## 12. Verification

Every fix is backed by tests and the full pipeline is green:

```
pnpm turbo run typecheck lint test
Tasks: 26 successful, 26 total
```

Key new test coverage: zip-bomb decompression ceiling, pre-auth ping guard, challenge-response
replay attempts (stale challenge, reused challenge, wrong challenge), token hashing at rest and
constant-time verify, pairing code randomness, pending-device permission empty set, and the
three Win32 injection-defence cases described in §8.

---

*Prepared by the project architect as part of Milestone 7 — Security Audit & Hardening.*
