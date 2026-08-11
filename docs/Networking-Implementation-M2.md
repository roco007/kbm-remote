# KBM Remote — Networking Layer Implementation (Milestone 2)

This document records how the networking layer was implemented, verified, and wired into the two application shells. It is the companion to the [`Protocol-Documentation.md`](./Protocol-Documentation.md) specification and the architecture work from Milestone 1. The layer implemented here is the **entire transport, session, and security scaffolding** — WebSocket server and client, TLS identity, heartbeats, latency monitoring, authentication middleware, frame routing, and reconnection — with **no input-emulation logic yet**, exactly as scoped.

## 1. Scope and Verification Summary

The milestone delivered two new packages and app-level wiring, backed by a test suite that exercises the wire contract end-to-end rather than through mocks alone.

| Component | Location | Test coverage |
| --- | --- | --- |
| Binary protocol codec | `packages/protocol` | 15 tests — MessagePack round-trip, DEFLATE compression threshold boundary, compressor injection, envelope validation |
| Network transport & client/server | `packages/network` | 46 tests — latency metrics, retry/reconnect constants, full client lifecycle on a fake socket, frame router, auth middleware, gateway end-to-end against a real `ws` client |
| Receiver app wiring | `apps/receiver` | 8 tests — real TLS server, real WebSocket client, Hello/HelloAck, subprotocol negotiation, version gating, authentication flow, 4001 close on invalid token |
| Sender app wiring | `apps/sender` | 8 tests — connection lifecycle, session resume, graceful disconnect, disposal, inbound message routing |

**All monorepo gates pass**: `pnpm turbo build`, `typecheck`, `lint`, and `test` are green (61 tests total across the two apps, 46 in the network package, 15 in the protocol package).

## 2. Package Layout

The two packages form a clean dependency chain: `@kbm-remote/protocol` has zero runtime dependencies beyond MessagePack and pako; `@kbm-remote/network` consumes the protocol codec and adds transport, server, client, monitoring, and TLS primitives. The apps consume `network` and remain ignorant of codec internals.

```
packages/
├── protocol/            # Wire format (Spec §2–§7)
│   └── src/
│       ├── codec/       #   encodeFrame / decodeFrame, DEFLATE, versioned envelopes
│       ├── types/       #   FrameType registry, FrameEnvelope schema
│       └── validation/  #   validateEnvelope, isValidFrameType
└── network/             #   Transport and session machinery
    └── src/
        ├── client/      #   ClientConnection — full connection lifecycle
        ├── server/      #   WssGateway, FrameRouter, AuthMiddleware
        ├── transport/   #   TLS identity: cert generation, fingerprint pinning
        ├── monitoring/  #   LatencyMetrics — RTT, jitter, loss, quality
        ├── common/      #   Subprotocol, timeouts, close codes, backoff math
        ├── discovery/   #   Placeholder for mDNS/Bonjour (M3)
        └── logging/     #   Structured Logger
```

## 3. Wire Contract

Every frame on the wire is a MessagePack-encoded envelope, optionally DEFLATE-compressed:

```ts
interface FrameEnvelope {
  t: number;      // FrameType discriminator
  mid: number;    // message id — 0 = fire-and-forget; >0 = reliable, earns an Ack
  v: number;      // protocol major version (1)
  ts: number;     // sender wall-clock ms
  p: Record<string, unknown>; // type-specific payload
}
```

Small frames (raw payload ≤ 256 bytes, `COMPRESSION_THRESHOLD_BYTES`) are sent uncompressed. Larger frames are DEFLATE-compressed in-place and shipped as `{ t, mid, v, ts, c: 1, p: { __raw: number[] } }`. The codec is symmetric and version-gated: `decodeFrame` rejects envelopes whose major version does not match the receiver's supported set.

## 4. Session Lifecycle (Implemented)

The implemented handshake mirrors Spec §3:

| Phase | Wire exchange | Implementation |
| --- | --- | --- |
| Transport | TCP → TLS 1.3 → WSS upgrade with subprotocol `kbmremote.v1+msgpack` | `https.createServer({key, cert})` + `ws.WebSocketServer({server})` with `verifyClient` |
| Handshake | Sender `Hello` (mid=1) → Receiver `HelloAck` {sessionId} | Registered router handler in `NetworkService`; gateway auto-Acks mid>0 |
| Authentication | Sender `Authenticate` {sessionId, sessionToken} → `AuthOk` / `AuthFailed` | `AuthMiddleware.verifyAuthenticate` against an `AuthStore`; session promotion via `gateway.authenticate` |
| Operational | `Ping`/`Pong` every 5 s; reliable frames earn `Ack`; `Nack` on protocol violations | `LatencyMetrics` + `ClientConnection` retry loop + watchdog |
| Shutdown | `Disconnect` echo, 2 s grace, then close 4006 | `WssGateway.stop()` drain sequence |

Subprotocol negotiation is enforced at the WebSocket level: clients that fail to negotiate `kbmremote.v1+msgpack` receive an HTTP rejection before any frame is parsed. Protocol major version is checked per-frame at the router; an unsupported major version (`v !== 1`) closes the connection with **4004**. Authentication failure after a valid handshake closes with **4001** (`NotAuthenticated`).

## 5. Security Model (Transport Layer)

The receiver generates a **self-signed RSA-2048 certificate with a SHA-256 fingerprint** on first start (library `selfsigned`, re-exported through `@kbm-remote/network`). The fingerprint is the **QR pairing payload** (Spec §2.6): the mobile sender displays it to the user for out-of-band verification and pins it for the session. Certificate generation and fingerprinting live in `packages/network/src/transport/tls.ts` (`generateSelfSignedCert`, `fingerprintOf`, `parseCertificate`).

Key design decisions worth recording:

1. **Node's `https` wrapper, not a bare `tls.Server`.** The `ws` library's subprotocol negotiation requires the HTTP server to emit `upgrade` events, which a raw `node:tls` server does not do reliably. The receiver therefore creates `https.createServer({key, cert})` and hands it to the WebSocket server — the TLS posture (TLS 1.2+, RSA 2048, SHA-256 fingerprint) is unchanged.
2. **Close-frame flushing.** Handlers that send a terminal reply (`AuthOk`/`AuthFailed`) and then close the socket synchronously would drop their own reply. The gateway now tracks in-flight encode/send promises per socket and flushes them (bounded by a 1 s guard) before emitting the close handshake.
3. **Rate limiting and revocation hooks.** `AuthStore` exposes `isRateLimited` and `recordPairingAttempt` / `revoked` semantics; the in-memory default store enforces revocation, and M1 will persist hashed tokens.

## 6. Heartbeat, Reconnect, and Latency

`LatencyMetrics` (network/monitoring) maintains a rolling 32-sample RTT window (median), jitter (standard deviation), and a 60 s loss window, mapping to a **quality band**: `good` (< 25 ms median), `degraded` (25–75 ms), `poor` (> 75 ms). The client's ping loop fires every 5 s (`PING_INTERVAL_MS`); four consecutive missed pongs trigger reconnection. Backoff uses exponential jitter — `min(250·2^i, 3000) + rand(0, 250)` per reliable-send retry attempt and `rand(0, min(500·2^i, 10_000))` per reconnect attempt — so bursty failure never synchronizes across devices. A silence watchdog closes idle connections (> 15 s) server-side with 4001.

These thresholds are pinned by tests (`tests/common.test.ts`) so accidental drift in latency guarantees is caught by CI.

## 7. App Wiring

### Receiver — `apps/receiver/src/main/networkService.ts`

`NetworkService` is the composition root for the networking layer. It generates the TLS identity, binds an HTTPS server, starts the `WssGateway`, and registers the two pre-authentication handlers (`Hello` → `HelloAck` with an assigned stable `sessionId`; `Authenticate` → `AuthOk`/`AuthFailed` with 4001 close on invalid tokens). It also hosts the default in-memory `AuthStore` until M1 ships persistent storage. The service exposes `start() → {port, fingerprint}` and `stop()`, and reports `sessionCount`. The Electron main process starts the service at boot; pairing-code UI (QR rendering) consumes `fingerprint`.

### Sender — `apps/sender/src/services/connectionManager.ts`

`ConnectionManager` wraps `ClientConnection` with a typed event emitter (`stateChange`, `message`, `reconnecting`) and exposes `connect({url, source})`, `setUrl`, `disconnect()`, and `dispose()`. The `socketFactory` indirection keeps it portable: the Node test build uses the `ws` package, and the React Native build will inject `global.WebSocket`. Session resumption (`resume: {sessionId, sessionToken}`) is stored client-side and replayed in `Hello`'s `resumeSessionId` field.

## 8. Test Strategy and Lessons Learned

Unit tests deliberately avoid mocks where the wire matters. The client tests run `ClientConnection` against a **fake socket with fake timers** (deterministic heartbeat/retry scenarios), while the server and app tests spin up a **real WebSocket server or TLS server with real `ws` clients**. Four debugging lessons are preserved here for future contributors:

1. **msgpack pooled buffers.** `decode()` refuses Uint8Arrays whose `.buffer` extends past the slice; helpers must pass `buffer.slice(byteOffset, byteOffset + byteLength)`.
2. **Fake timers must drain timeouts in a loop**, firing each interval handler exactly once per tick — a subtle bug that broke the retry-exhaustion test until fixed.
3. **Async codec sends.** `sendTo`/`sendFrame` encode via dynamic `import()` of the protocol package, so every send is asynchronous; tests must settle microtasks after driving the clock or invoking send.
4. **Real TLS behavior.** A raw `node:tls.Server` does not emit WebSocket `upgrade` events; the `https.createServer` wrapper is required for ws library integration.

## 9. Latency Budget

The measured overhead of the networking layer alone (codec + TLS framing, LAN) is dominated by the TLS handshake (once per connection) and the 5 s heartbeat interval. Per-frame cost is a single MessagePack encode/decode plus optional DEFLATE, which the codec tests bound below 256 bytes uncompressed. The application-level latency target of ≤ 50 ms (Spec §1) is evaluated at M3, when input frames begin traversing this layer; the `quality` band telemetry gives us the observability hook (`conn.metrics.rtt`, `conn.metrics.quality`) to enforce it.

## 10. What Is Not Yet Implemented

The following remain on the roadmap and are intentionally absent: mDNS/Bonjour discovery (the `discovery` module is a placeholder), QR pairing UI, persistent trusted-device storage, clipboard/media/file command handlers, and input emulation. The router's `PRE_AUTH_TYPES` set (`Hello`, `PairRequest`, `PairResponse`, `Authenticate`) is ready to receive the pairing sequence in M3 without touching the transport layer.

## 11. Running the Tests

```bash
# Monorepo-wide (all gates)
pnpm turbo build typecheck lint test --force

# Package-level
cd packages/network && pnpm test      # 46 tests
cd packages/protocol && pnpm test     # 15 tests
cd apps/receiver && pnpm test         # 8 tests (real TLS + ws client)
cd apps/sender && pnpm test           # 8 tests (fake receiver)
```
