# KBM Remote Protocol Specification

## Communication Protocol for the Remote Keyboard & Mouse Emulator

**Author:** Manus AI
**Version:** 1.0 (protocol freeze — this document is the contract between the `protocol` shared package and both applications)
**Date:** August 11, 2026
**Companion documents:** Architecture Design Document v1.1 · Technology Evaluation Report · UX Design Document

---

## 1. Overview and Design Goals

This specification defines every message exchanged between a **sender** (mobile client) and a **receiver** (desktop server) in KBM Remote. The protocol is designed around five constraints inherited from the architecture: input events must be delivered with glass-to-glass latency under 50 ms over a LAN; the same connection must carry latency-sensitive streaming traffic (mouse, keyboard, media) and reliability-critical traffic (clipboard, pairing, file transfer) simultaneously; all traffic must remain confidential and authentic on an untrusted local network; both endpoints must tolerate Wi-Fi churn without user-visible interruption; and the wire format must be evolvable so that v1.0 and future versions interoperate.

The protocol runs over **WebSocket Secure (WSS)** — TLS 1.3 over TCP with an HTTP upgrade — consistent with the Architecture Design Document's transport decision. TLS provides encryption and server authentication; the protocol layer adds application authentication (pairing/session tokens), liveness (heartbeats), reliability (per-message acknowledgements where needed), and observability (latency monitoring).

| Goal                         | Mechanism                                                                          | Target                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Encryption                   | TLS 1.3 (per-receiver certificate) + sender certificate pinning                    | All bytes on the wire are confidential and server-authenticated |
| Low latency                  | Binary codec, input batching in ≤8 ms windows, unreliable-default for input frames | Glass-to-glass ≤50 ms on a LAN                                  |
| Reliability where it matters | Per-message acknowledgements for clipboard, pairing, file chunks, commands         | At-least-once for acknowledged types                            |
| Liveness                     | Bidirectional 5 s ping/pong with RTT accounting                                    | Dead-connection detection ≤15 s                                 |
| Resilience                   | Exponential-backoff reconnect, session-token resume, monotonic sequence numbers    | Wi-Fi drop invisible ≤2 s in practice                           |
| Efficiency                   | MessagePack binary encoding; optional per-frame DEFLATE above a size threshold     | Typical input frame ≤40 bytes; clipboard compressed             |
| Evolvability                 | Semantic versioning, capability negotiation in Hello, unknown-field tolerance      | v1.x clients talk to v1.y servers                               |

---

## 2. Wire Format

### 2.1 Transport

Every KBM Remote session is exactly one WebSocket connection from sender to receiver. The connection uses binary frames exclusively; the subprotocol header advertises the negotiated codec and version:

```
Sec-WebSocket-Protocol: kbmremote.v1+msgpack
```

WebSocket framing (per-message boundaries, masked client frames, 10xx close codes) is used as-is; the application never fragments a logical message across frames, and it never sends text frames.

### 2.2 Why binary (MessagePack), not JSON

JSON was considered and rejected for the data path. On a LAN the bandwidth difference is negligible, but the encoding cost is not: the hot path is a `MouseMove` stream of hundreds of frames per second, and JSON requires string-key parsing, decimal float formatting, and roughly 3–4× the bytes per event. MessagePack retains JSON's self-describing, schema-tolerant map structure — so debuggability and evolvability survive — while cutting a typical `MouseMove` from ~140 bytes of JSON to ~24 bytes, and reducing encode/decode CPU enough to keep the input thread comfortably inside the 8 ms batching budget. For the rare frames a developer wants to inspect (pairing, errors), the same types can be pretty-printed losslessly because MessagePack maps are key-value maps.

### 2.3 Application frame layout

Every WebSocket message is a MessagePack map that begins with a `t` (type) field and a `mid` (message id) field. The full generic envelope is:

```
Frame  = {
  "t":   uint      — message type discriminator (see catalog, §4)
  "mid": uint32    — sender-local monotonic message id (0 = no ack needed)
  "v":   uint8     — protocol major version this frame was produced against
  "ts":  uint64    — sender wall-clock ms (epoch, monotonic where noted)
  "p":   map       — payload, type-specific
}
```

Fields omitted for brevity in §4 are part of this envelope. The `mid` semantics: the sender assigns a strictly increasing `mid` to every frame for which it wants an acknowledgement; `mid = 0` marks fire-and-forget frames (input events, pings, pongs), which the receiver never acks and the sender never resends. This single convention collapses the acknowledgement/retry design into one rule: **if `mid > 0`, the frame is reliable and the sender must see an `Ack` before its retry budget expires; if `mid = 0`, the frame is best-effort and is never retransmitted.**

### 2.4 Numeric conventions

All integers are unsigned; timestamps are milliseconds since Unix epoch unless marked _relative_ (relative timestamps use the sender's monotonic clock). Coordinates use receiver screen pixels (multi-monitor virtual desktop space). Floats encode relative motion in raw device units as signed integers (deltas) — never floating point — which keeps `MouseMove` payloads at two int16 values.

### 2.5 Compression

Per-frame compression is negotiated capability (`cap.compression: ["deflate"]`) and applied per message with a simple rule: frames whose raw payload exceeds **256 bytes** are DEFLATE-compressed and marked with envelope field `"c": 1`; the receiver decompresses on read. Input events almost never exceed the threshold and therefore fly uncompressed (and un-decompressed), keeping the hot path at zero cost; clipboard text, file chunks, and slide previews exceed it routinely and compress 5–10×. WebSocket permessage-deflate is deliberately **not** used because its streaming dictionary semantics make reconnection context recovery error-prone, and a whole-message threshold rule is simpler to reason about in tests.

### 2.6 Encryption

Encryption is fully delegated to TLS 1.3 on the underlying connection. No application-level cipher is layered on top — the pairing protocol proves the sender knows a secret derived from the pairing code (§5.3), and certificate pinning binds the sender to the correct receiver, so a man-in-the-middle cannot read or inject frames. The protocol layer's job is authentication and integrity of _sessions_, not confidentiality of _bytes_.

### 2.7 Protocol versioning

The wire contract is versioned semantically. The subprotocol string carries the major version (`kbmremote.v1+msgpack`); the frame envelope carries `v`; and the `Hello` exchange performs capability negotiation. Rules:

1. A sender and receiver whose major versions differ refuse to proceed with `UnsupportedVersion` and close gracefully (code 4004, §6.4).
2. Minor-version differences are tolerated: each side ignores unknown map keys in the payload it does not understand (forward compatibility), and a sender MAY set only the keys a receiver declared in `HelloAck.capabilities`.
3. New message types are additions only; no existing type's field set shrinks. Deprecated types are marked `deprecated` in this catalog for one major version before removal.
4. Capability negotiation (e.g., `compression`, `fileTransfer`, `presentation`) lets older clients connect to newer servers without feature churn.

---

## 3. Session Lifecycle

A session progresses through four phases, each with a distinct state machine. The full sequence is illustrated below.

![Connection handshake and session lifecycle](protocol/handshake.png)

### 3.1 Phase 1 — Transport establishment

The sender opens a TCP connection to the receiver's listening port and completes the TLS 1.3 handshake. The sender's TLS stack **pins** the receiver's certificate by the SHA-256 fingerprint carried in the pairing QR code / stored from the last successful pairing. A pin mismatch aborts with a user-visible warning ("certificate changed — this receiver may be an impersonator"). The receiver may be configured to reject connections before the HTTP upgrade for any TLS failure; there is no unencrypted mode.

### 3.2 Phase 2 — WebSocket upgrade

The sender issues the HTTP/1.1 upgrade request with the versioned subprotocol. The receiver responds `101 Switching Protocols`. If the subprotocol does not match any the receiver supports, the receiver responds `400 Bad Request` and the sender falls back to a lower version string before failing to `UnsupportedVersion`.

### 3.3 Phase 3 — Application authentication

No operational frame is processed before the authentication exchange completes. The sequence is:

| Step | Direction | Message                                                           | Notes                                             |
| ---- | --------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| 1    | S→R       | `Hello`                                                           | capability negotiation; authenticated or not      |
| 2    | R→S       | `HelloAck`                                                        | assigns session identity; declares `authRequired` |
| 3a   | S→R       | `PairRequest` → `PairChallenge` → `PairResponse` → `PairApproved` | unpaired device                                   |
| 3b   | S→R       | `Authenticate` → `AuthOk`                                         | paired device                                     |
| —    | R→S       | `AuthFailed` → close                                              | any authentication failure                        |

The details of 3a/3b are in Section 5.3. Until `AuthOk`/`PairApproved` arrives, the receiver's state machine accepts only `Hello`, `PairRequest`, `PairResponse`, and `Authenticate`; every other type returns `NotAuthenticated` (close 4001).

### 3.4 Phase 4 — Operational

After authentication, the connection enters the operational state: input frames flow from sender to receiver, control/telemetry frames flow in both directions, pings run on a 5-second timer, and acknowledged frames drive the retry timer. Either side may close gracefully at any time with `Disconnect` (clean, 1000) or an error code from §6.4.

### 3.5 Timeouts

| Timeout           | Value                                   | Triggered behavior                                     |
| ----------------- | --------------------------------------- | ------------------------------------------------------ |
| Auth window       | 30 s from `Hello`                       | Receiver closes with 4001 if authentication incomplete |
| Heartbeat silence | 15 s without any frame (including pong) | Both sides treat connection as dead                    |
| Ping interval     | 5 s (sender-driven)                     | RTT sample; missed pong increments dead counter        |
| Ack window        | 2 s + 1× measured RTT                   | Retry/re-assign `mid` per §5.2                         |
| TCP idle          | —                                       | never; heartbeats keep the socket warm                 |

---

## 4. Message Catalog

Every message is defined below with its envelope type discriminator, payload schema, direction, acknowledgement class, and semantics. The catalog is exhaustive for v1.0; anything not listed here is not a valid v1 frame.

### 4.1 Type registry

| Type ID | Name                                                | Direction                   | Ack class | Section |
| ------- | --------------------------------------------------- | --------------------------- | --------- | ------- |
| 0x01    | `Hello`                                             | S→R                         | none      | 4.2     |
| 0x02    | `HelloAck`                                          | R→S                         | none      | 4.2     |
| 0x03    | `Authenticate`                                      | S→R                         | yes       | 5.3     |
| 0x04    | `AuthOk`                                            | R→S                         | none      | 5.3     |
| 0x05    | `AuthFailed`                                        | R→S                         | none      | 5.3     |
| 0x10    | `PairRequest`                                       | S→R                         | yes       | 5.3     |
| 0x11    | `PairChallenge`                                     | R→S                         | none      | 5.3     |
| 0x12    | `PairResponse`                                      | S→R                         | yes       | 5.3     |
| 0x13    | `PairApproved`                                      | R→S                         | none      | 5.3     |
| 0x14    | `PairDenied`                                        | R→S                         | none      | 5.3     |
| 0x20    | `Ping`                                              | S→R                         | none      | 5.1     |
| 0x21    | `Pong`                                              | R→S                         | none      | 5.1     |
| 0x30    | `Ack`                                               | R→S (and S→R for clipboard) | n/a       | 5.2     |
| 0x31    | `Nack`                                              | R→S                         | n/a       | 5.2     |
| 0x40    | `MouseMove`                                         | S→R                         | none      | 4.3     |
| 0x41    | `MouseClick`                                        | S→R                         | none      | 4.3     |
| 0x42    | `MouseScroll`                                       | S→R                         | none      | 4.3     |
| 0x43    | `MouseDragStart` / `MouseDragMove` / `MouseDragEnd` | S→R                         | none      | 4.3     |
| 0x50    | `KeyPress`                                          | S→R                         | none      | 4.4     |
| 0x51    | `KeyHold` / `KeyRelease`                            | S→R                         | none      | 4.4     |
| 0x52    | `TextInput`                                         | S→R                         | none      | 4.4     |
| 0x53    | `Shortcut`                                          | S→R                         | none      | 4.4     |
| 0x60    | `MediaKey`                                          | S→R                         | none      | 4.5     |
| 0x70    | `ClipboardSync`                                     | both                        | yes       | 4.6     |
| 0x71    | `ClipboardQuery`                                    | S→R                         | yes       | 4.6     |
| 0x80    | `FileTransfer`                                      | both                        | yes       | 4.7     |
| 0x90    | `Command`                                           | S→R                         | yes       | 4.8     |
| 0x91    | `CommandResult`                                     | R→S                         | none      | 4.8     |
| 0xA0    | `Notification`                                      | R→S                         | none      | 4.9     |
| 0xA1    | `SessionInfo`                                       | R→S                         | none      | 4.9     |
| 0xB0    | `PresentationSlide`                                 | R→S                         | none      | 4.10    |
| 0xC0    | `DisplayQuery`                                      | S→R                         | yes       | 4.11    |
| 0xC1    | `DisplayList`                                       | R→S                         | none      | 4.11    |
| 0xD0    | `Disconnect`                                        | both                        | none      | 6.3     |
| 0xE0    | `UnsupportedVersion`                                | both                        | none      | 2.7     |

### 4.2 Connection setup — `Hello`, `HelloAck`

```
Hello        p = { protoVersion: "1.0",
                   clientName: string,          // e.g. "Raj's iPhone"
                   clientOs: "android"|"ios",
                   capabilities: string[],      // e.g. ["deflate","fileTransfer","presentation"]
                   clientTs: uint64 }           // client wall clock, for drift estimate

HelloAck     p = { serverVersion: "1.0",
                   sessionId: string,           // 16-byte hex, stable per pairing
                   serverTs: uint64,
                   authRequired: bool,
                   capabilities: string[],
                   maxInFlight: uint8,          // sender throttle hint (default 256)
                   permissions: string[] }      // granted ops for this client; empty until AuthOk
```

`Hello` is the single point of version and capability negotiation (rules in §2.7). The receiver echoes a stable `sessionId` that the sender stores for token-based re-authentication on reconnect; it never leaks outside the pair. `permissions` reflects the device policy at authentication time — the sender should disable UI features it is not permitted to use, and the receiver re-enforces permissions on every operational frame regardless.

### 4.3 Mouse events — `MouseMove`, `MouseClick`, `MouseScroll`, drag trio

Mouse traffic is the hottest stream: best-effort, fire-and-forget (`mid = 0`), batched into packets carrying up to 8 ms of events. A stale mouse event is worthless; a missing one is fine, because the _next_ `MouseMove` (which is absolute for moves) self-corrects.

```
MouseMove     p = { display: uint8,             // target display index from DisplayList
                    x: int16, y: int16 }         // absolute receiver pixels, virtual-desktop coords

MouseClick    p = { button: "left"|"right"|"middle",
                    action: "down"|"up"|"click"|"dblclick",
                    display: uint8, x: int16, y: int16 }

MouseScroll   p = { axis: "vertical"|"horizontal",
                    amount: int8 }               // signed scroll ticks; sender clamps gesture to ±8

MouseDragStart p = { button: "left"|"middle", display: uint8, x: int16, y: int16 }
MouseDragMove  p = { display: uint8, x: int16, y: int16 }     // relative deltas while dragging
MouseDragEnd   p = { button: string }
```

Drag uses an explicit stateful trio so a dropped connection mid-drag is visible: if the receiver sees a `MouseDragMove` without an active drag session, it synthesizes `MouseDragEnd` and the sender, on reconnect, is told via `SessionInfo` that an in-flight drag was terminated. `display` selection enables multi-monitor support: the sender maps its gestures to the receiver's virtual-desktop coordinate space reported by `DisplayList`, so differing resolutions are handled entirely by the coordinate contract, not by the transport.

### 4.4 Keyboard events — `KeyPress`, `KeyHold`/`KeyRelease`, `TextInput`, `Shortcut`

```
KeyPress      p = { keys: string[] }             // e.g. ["ControlLeft","KeyC"] atomic combo

KeyHold       p = { key: string }                // begin holding; must pair with KeyRelease
KeyRelease    p = { key: string }

TextInput     p = { text: string }               // up to 4 KB; surrogate-paired UTF-16-safe text
                                                // receiver injects into the focused field via C-S-V path or
                                                // platform text-input API depending on InputProvider

Shortcut      p = { keys: string[], holdMs: uint16 }   // server-side recorded shortcut name
                                                // e.g. "lockScreen"; validated against permissions
```

`keys` follow a stable key-identifier grammar — modifier side explicit (`ControlLeft`/`ControlRight`), letter keys in `KeyX` form — so platform keymaps never need to round-trip through locale names. `TextInput` is acknowledged (`mid > 0`) because the sender offers an on-screen "send" confirmation UX; delivery failures surface as a visible error rather than silently dropped text.

### 4.5 Media controls — `MediaKey`

```
MediaKey      p = { key: "volumeUp"|"volumeDown"|"mute"|"playPause"|
                           "prevTrack"|"nextTrack" }
```

Media frames are best-effort like other input; a duplicated or dropped volume tick is acceptable and the next user gesture supersedes it. The receiver maps the abstract key to the OS media-key mechanism (SendInput extended keys on Windows, CGEvent media codes on macOS, XTest keysyms on Linux) via the `InputProvider`.

### 4.6 Clipboard — `ClipboardSync`, `ClipboardQuery` (acknowledged)

Clipboard is the flagship _reliable_ channel: text and images must arrive intact and at-most-once-visible to the user. Every clipboard frame carries `mid > 0`.

```
ClipboardSync  p = { direction: "toReceiver"|"fromReceiver",
                     kind: "text"|"image",
                     content: binary,            // text UTF-8 ≤1 MB, image PNG ≤4 MB raw
                     checksum: uint32,           // CRC-32 of content
                     seq: uint32 }               // per-direction monotonic; duplicates dropped by seq

ClipboardQuery p = { }                          // sender requests receiver's current clipboard
```

The receiver replies to `ClipboardQuery` (and to its own clipboard changes, when sync is permitted by policy) with `ClipboardSync direction: "fromReceiver"`. Both sides drop a frame whose `seq` equals the last seen, which makes idempotent retries from §5.2 safe: a retried `ClipboardSync` that already arrived is recognized and double-acknowledged without re-applying.

### 4.7 File transfer — `FileTransfer` (acknowledged, chunked)

File transfer rides the same WebSocket with a chunked, windowed upload/download:

```
FileTransfer   p = { op: "open",     name: string, size: uint64, mime: string, seq: uint32 }
FileTransfer   p = { op: "chunk",    data: binary,      // ≤64 KB raw
                     seq: uint32, chunkIndex: uint32, totalChunks: uint32 }
FileTransfer   p = { op: "end",      checksum: uint32, seq: uint32 }
FileTransfer   p = { op: "error",    reason: string, seq: uint32 }
```

Each `open`/`chunk`/`end` is a distinct acknowledged message (fresh `mid`), and chunks are sequenced with `chunkIndex`. The sender's window is `maxInFlight` from `HelloAck` (default 4 for transfers); a `Nack` or missing `Ack` stops the window, and the sender retransmits from the last acknowledged `chunkIndex`. A transfer `seq` lets either side abort and restart cleanly.

### 4.8 Remote commands — `Command`, `CommandResult`

Generic acknowledged commands cover one-shot receiver actions not in the input families:

```
Command        p = { name: "lockScreen"|"sleep"|"openApp"|"screenshot"|"getSlideInfo",
                     args: map }

CommandResult  p = { name: string, ok: bool, result: map|null, error: string|null }
```

`Command` is the extension point: new operational verbs are added as `name` values, keeping the type registry stable while functionality grows (this is how presentation-mode slide info, remote-terminal, and Wake-on-LAN would land as v1.x additions).

### 4.9 Telemetry and notifications — `Notification`, `SessionInfo`

```
Notification   p = { level: "info"|"warn"|"error", message: string, code: string }
                                // receiver-pushed user-facing notices (e.g. "clipboard denied by policy")

SessionInfo    p = { dragTerminated: bool, displaysChanged: bool,
                     permissionsUpdated: string[]|null }
                                // server-sent session corrections (see §4.3 drag semantics)
```

### 4.10 Presentation — `PresentationSlide`

```
PresentationSlide p = { slideIndex: uint16, total: uint16,
                        image: binary|null,      // thumbnail PNG ≤256 KB, sent when changed
                        notes: string, appName: string }
```

Best-effort: the preview image is a _nice to have_; slide navigation is driven by the same best-effort `MouseClick`/`Shortcut` channel, so a dropped preview never blocks advancing a slide. Bandwidth for the image is gated by the `presentation` capability and by a 2-second cadence limit.

### 4.11 Display negotiation — `DisplayQuery`, `DisplayList`

```
DisplayQuery   p = { }
DisplayList    p = { displays: [ { index: uint8, x: uint16, y: uint16,
                                   width: uint16, height: uint16, scale: float32,
                                   primary: bool } ],
                     vdlWidth: uint16, vdlHeight: uint16 }
                                // virtual-desktop bounds in receiver pixels
```

`DisplayList` is the single source of truth for coordinate mapping: the sender computes gestures in this space, which is why `MouseMove` needs only two int16 values even across heterogeneous resolutions.

### 4.12 Disconnect — `Disconnect`

```
Disconnect     p = { reason: string, graceful: bool }
```

A peer wishing to close cleanly sends `Disconnect` then waits up to 2 s for an echo before closing the WebSocket with code 1000. §6.3 lists error close codes.

---

## 5. Reliability Mechanisms

### 5.1 Heartbeats and latency monitoring — `Ping`, `Pong`

The sender emits `Ping` every 5 s with an opaque sequence and its monotonic send timestamp; the receiver replies with `Pong` carrying the echoed sequence and its receive timestamp. Three quantities are derived per round trip:

| Metric | Formula                                                                                      | Use                                                    |
| ------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| RTT    | `pong.ts_sent − ping.ts_sent` (receiver clocks excluded; sender measures arrival minus send) | Retry timeout base (2 s + RTT), UX latency chip        |
| Jitter | rolling stddev of last 32 RTTs                                                               | Triggers the `warn` notification when >50 ms sustained |
| Loss   | fraction of pings without pong in the last 60 s                                              | Connection-quality chip (good/degraded/poor)           |

A `Pong` is itself a "some frame" for the 15 s silence timeout (§3.5), so a quiescent session never looks dead. Pings are `mid = 0`; a lost ping costs nothing, and 3 consecutive missed pongs transition the sender to the reconnect state.

### 5.2 Acknowledgements and retries

Reliable frames (`mid > 0`) live in the sender's outbox until an `Ack(mid)` arrives. The receiver acks synchronously after applying the frame (clipboard after persisting, file chunks after writing, commands after dispatch) and may respond `Nack(mid, reason)` for a frame it refused (permission denied, payload over limit) so the sender can fail visibly instead of retrying. Retry policy is exponential backoff with jitter, capped at 4 attempts over ~10 s:

```
retry(i) = min(2^i × 250 ms, 3 s) + random(0, 250 ms)   for i = 0..3
```

After exhausting retries the frame fails to the UX layer; for `ClipboardSync` this becomes the on-screen "send failed — retry?" state. Crucially, `mid`s are never reused, and `seq`/`checksum` fields on replay-sensitive payloads make re-delivery idempotent, so a network that delivers both the original and the retry cannot produce double side effects.

### 5.3 Authentication handshake detail

The unpaired flow (first-time pairing) is a proof-of-possession exchange over the already-TLS-protected channel, mirroring the architecture's pairing model:

1. Sender sends `PairRequest { pairingCode, ephemeralKey }` — the 8-character code from the receiver's pairing screen, plus a Curve25519 public key for optional forward-secret payload derivation.
2. Receiver replies `PairChallenge { challenge }` — 32 random bytes.
3. Sender computes `proof = HMAC-SHA256(challenge, HKDF-derived key from pairingCode + ephemeral secret)` and sends `PairResponse`.
4. Receiver verifies against its knowledge of the active pairing code (5-minute TTL, single concurrent session, rate-limited at 5/hour). On success it issues `PairApproved { sessionToken, permissions }`; the sender stores `sessionToken` (its own secret) hashed with the receiver's cert fingerprint. The receiver stores only the token's SHA-256 hash.

On every subsequent connection the sender skips this ceremony and sends `Authenticate { sessionId, sessionToken }`; the receiver hashes the presented token and compares it to the stored hash, replying `AuthOk { identity, permissions }`. Token revocation is immediate: the receiver deletes the hash and the next `Authenticate` yields `AuthFailed { reason: "revoked" }`, followed by close code 4003. `AuthFailed` for any other reason (wrong code, expired code, rate limit) always ends the connection — authentication never degrades into a "try again" loop on the wire.

### 5.4 Reconnection

Reconnection is a fresh Phases 1–4 run on a new TCP socket — deliberately not a resumption over the old socket — because Wi-Fi churn makes old sockets unrecoverable. The sequence that makes reconnection fast and safe: the sender keeps the last `sessionId` and token and attempts exponential-backoff reconnects (500 ms → 1 s → 2 s → 4 s, then capped at 10 s) while showing "reconnecting…". On success, `Authenticate` restores the session; the receiver sends `SessionInfo` with any in-flight state (terminated drag, changed displays), and both sides' `seq` counters restart per-direction because unacknowledged reliable frames from the dead connection are re-sent with fresh `mid`s from the sender's outbox. There is no wire-level sequence-number carry-over: continuity is provided by idempotent payloads plus the session-correction message, which is simpler and provably correct under arbitrary loss.

---

## 6. Error Handling and Close Codes

### 6.1 Frame-level errors

A malformed or unauthorized frame never tears the connection down silently: the receiver replies `Nack` with a `reason` code (`malformed`, `notAuthenticated`, `permissionDenied`, `payloadTooLarge`, `unknownType`) and continues processing. Only authentication and version failures are connection-fatal at the frame level.

### 6.2 Latency and quality degradation

The receiver never stops accepting input because of latency — input is always best-effort — but sustained RTT above thresholds drives the UX: the sender's latency chip moves through _good_ (<25 ms) / _degraded_ (25–75 ms) / _poor_ (>75 ms), and the receiver's log records a `WARN` for every 10-second window averaging above 75 ms, per the UX design's observability requirements.

### 6.3 WebSocket close codes

| Code | Meaning                                                      | Direction |
| ---- | ------------------------------------------------------------ | --------- |
| 1000 | Normal; `Disconnect` frame preceded                          | both      |
| 4001 | Not authenticated / auth window expired                      | R→S       |
| 4002 | Unsupported subprotocol/version (non-negotiable)             | both      |
| 4003 | Session revoked                                              | R→S       |
| 4004 | Incompatible major version (`UnsupportedVersion` sent first) | both      |
| 4005 | Rate limited (pairing attempts)                              | R→S       |
| 4006 | Server shutting down (graceful drain)                        | R→S       |

### 6.4 Recovery matrix

| Failure                    | Detection                    | Recovery                                         |
| -------------------------- | ---------------------------- | ------------------------------------------------ |
| Missed ack                 | ack window expiry (§3.5)     | Retransmit per §5.2; fail to UX after 4 attempts |
| Missed pongs (×3)          | heartbeat monitor            | Enter reconnect backoff (§5.4)                   |
| TLS pin change             | Phase 1                      | Abort; user-visible impersonation warning        |
| Auth failure               | `AuthFailed`                 | Close 4001/4003; UX shows reason verbatim        |
| Drag mid-flight disconnect | `SessionInfo.dragTerminated` | Sender UI re-centers cursor affordance           |
| File chunk loss            | ack window / `Nack`          | Retransmit from last acked `chunkIndex`          |

---

## 7. Implementation Contract (`protocol` package)

The wire contract is realized in the monorepo's `protocol` shared package: TypeScript interfaces mirror every message above; a codec module handles MessagePack encode/decode with the compression threshold; an `Envelope` type carries the generic fields of §2.3; and a `FrameValidator` enforces type-registry membership and payload bounds per message. Both applications depend on `protocol` and nothing else for wire concerns — this is the one dependency the architecture's clean-architecture boundary mandates. Wire-version bumps are coordinated through that package's CHANGELOG, and the type IDs above are frozen for the v1.x line.
