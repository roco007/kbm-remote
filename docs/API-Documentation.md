# API Documentation — KBM Remote v1.0

This document specifies the public APIs of the KBM Remote system: the wire protocol shared
by the sender and receiver, the network client and server packages, and the auth contract.
These are the boundaries external consumers (apps and future tooling) integrate against.
The internal clean-architecture layering is described in
[`Architecture-Design-Document.md`](./Architecture-Design-Document.md); the full wire
contract including field-level schemas lives in [`Protocol-Documentation.md`](./Protocol-Documentation.md).

## 1. Wire Protocol

Transport: WebSocket Secure (TLS 1.2+). Subprotocol: `kbm-remote-v1`. Payload: MessagePack,
optionally DEFLATE-compressed under the shared `FastCodec` with a **4 MiB decompression cap**
(`inflateCapped`). Protocol version `v = 1`, frozen for the v1.x line.

### 1.1 Frame Envelope

Every message is a `FrameEnvelope`:

```ts
interface FrameEnvelope {
  v: 1;                      // protocol version (frozen)
  t: number;                 // FrameType discriminator
  ts: number;                // sender monotonic timestamp (ms)
  mid?: number;              // message id — required for reliable frames (> 0)
  p: unknown;                // MsgPack payload specific to `t`
}
```

Reliable frames carry `mid > 0` and participate in the Ack/Nack retransmission protocol and
the per-session replay guard (`seenMids` deduplication). Control frames (Ping, Hello,
Authenticate) are fire-and-forget.

### 1.2 Frame Type Registry

| ID | Frame | Category | Reliability |
|----|-------|----------|-------------|
| `0x01` | Hello | Handshake | no |
| `0x02` | HelloAck | Handshake | no |
| `0x03` | Authenticate | Handshake | no |
| `0x04` | AuthOk | Handshake | no |
| `0x05` | AuthFailed | Handshake | no |
| `0x10`–`0x14` | PairRequest / PairChallenge / PairResponse / PairApproved / PairDenied | Pairing | no |
| `0x20` / `0x21` | Ping / Pong | Keep-alive, RTT | no |
| `0x30` / `0x31` | Ack / Nack | Reliability | no |
| `0x40`–`0x45` | MouseMove / MouseClick / MouseScroll / MouseDragStart / MouseDragMove / MouseDragEnd | Mouse | yes |
| `0x50`–`0x54` | KeyPress / KeyHold / KeyRelease / TextInput / Shortcut | Keyboard | yes |
| `0x60` | MediaKey | Media | yes |
| `0x70` / `0x71` | ClipboardSync / ClipboardQuery | Clipboard | yes |
| `0x80` | FileTransfer | File transfer (reserved) | yes |
| `0x90` / `0x91` | Command / CommandResult | Remote commands (reserved) | yes |
| `0xa0` / `0xa1` | Notification / SessionInfo | Control | no |
| `0xb0` | PresentationSlide | Presentation mode | yes |
| `0xc0` / `0xc1` | DisplayQuery / DisplayList | Multi-display | yes |
| `0xd0` | Disconnect | Session | no |
| `0xe0` | UnsupportedVersion | Handshake | no |

### 1.3 Handshake

1. **Hello** `{deviceId, deviceName, version}` → **HelloAck** `{serverName, version,
   challenge, sessionInfo}`. `challenge` is a fresh 96-bit random value; the receiver keeps
   only its SHA-256 hash.
2. **Authenticate** `{sessionId, sessionToken, challenge}` → **AuthOk** `{permissions}` or
   **AuthFailed** `{reason}`. The sender MUST echo the challenge; stale (>30 s) or reused
   challenges are rejected. Cert pinning is enforced by the sender before any further frames
   flow.
3. Pairing devices instead complete PairRequest → PairChallenge → PairResponse using the
   pairing code as proof; the owner approves in the dashboard (PairApproved/PairDenied).

### 1.4 Heartbeat and RTT

`Ping {seq, ts}` / `Pong {seq, ts, echoedTs}` run on an adaptive schedule (frequency drops
when the connection is idle). The client computes one-way RTT samples from `ts`/`echoedTs`
and surfaces a rolling median via `metrics` events.

### 1.5 Compression

`FastCodec.encode(envelope)` → `Buffer`; `decode(buffer)` validates the `v` version, then
MsgPack-decodes (compressed payloads are inflated via `inflateCapped`). The encoder coalesces
`MouseMove` frames client-side (latest-frame-wins) before transmission; see
[`Optimization-Benchmarks-M6.md`](./Optimization-Benchmarks-M6.md).

## 2. Network Package API

### 2.1 `WssGateway` (server)

```ts
class WssGateway {
  constructor(options: WssGatewayOptions);
  async start(tlsServer: TLSServer): Promise<void>;
  async stop(): Promise<void>;

  // Session management
  authenticate(sessionId: string, permissions: string[]): GatewaySession | null;
  sessionFor(ws: WebSocket): GatewaySession | undefined;
  sendTo(ws: WebSocket, frame: FrameEnvelope): void;
  recordAuthFailureFor(sessionId: string): number | null;
}
```

`WssGatewayOptions`:

```ts
interface WssGatewayOptions {
  onAuth: (payload: AuthenticatePayload) => Promise<AuthDecision>;
  onFrame: (session: GatewaySession, frame: FrameEnvelope) => void;
  onError: (error: Error, session?: GatewaySession) => void;
  maxFrameBytes?: number;      // default 16 MiB raw cap before decompression
  connectionsPerIp?: number;   // default 8
  preAuthTimeoutMs?: number;   // default 10 000
  maxPreAuthPings?: number;    // default 3
  authFailureLimit?: number;   // default 5 per 60 s window
  authFailureBanMs?: number;   // default 300 000
}
```

Security behaviour implemented by the gateway: DEFLATE cap, pre-auth ping guard,
auth-timeout watchdog (Hello/Authenticate resets it), per-IP connection limits,
auth-failure sliding-window throttling, and per-session `seenMids` replay deduplication.

### 2.2 `ClientConnection` (client)

```ts
class ClientConnection extends TypedEventEmitter<ClientEvents> {
  constructor(options: ClientOptions);
  async connect(): Promise<void>;
  disconnectGracefully(): void;
  async sendReliable(frame: Omit<FrameEnvelope, "mid" | "v">): Promise<FrameResult>;
  setUrl(url: string): void;
  setPeerCertificate(pem: string): void;   // TOFU — captured from pairing scan
}
```

`ClientOptions`:

```ts
interface ClientOptions {
  url: string;                             // wss://host:port
  deviceId: string;
  deviceName: string;
  sessionId?: string;
  sessionToken?: string;
  pinnedCert?: { fingerprint: string };    // required for pin gate
  checkServerCertificate?: (pem: string) => Promise<void>; // host pin gate
  maxInflight?: number;                    // reliability window, default 16
  heartbeatIntervalMs?: number;            // adaptive if unset
}
```

`ClientEvents`: `stateChange`, `helloAck`, `authOk`, `authFailed`, `certPinFailed`,
`metrics`, `error`, `disconnected`. State machine: `idle → connecting → connected →
authenticated`; a lost authenticated connection transitions through `reconnecting` with
exponential backoff. A failed certificate pin fires `certPinFailed`, closes the socket with
`NotAuthenticated("certPinMismatch")`, and blocks all further frames.

### 2.3 Discovery

`packages/network/src/discovery` exposes a strategy interface for mDNS advertisement
(`_kbmremote._tcp`) and lookup; the advertised TXT record carries the TLS port and the
pairing state.

## 3. Auth Package API

`@kbm-remote/auth` is pure TypeScript with no runtime dependencies — it is safe to import
into the mobile sender:

| Export | Purpose |
| --- | --- |
| `certs/` | Key/cert generation for the receiver's persisted TLS identity |
| `pairing/` | Uniform-random pairing code generation and verification |
| `session/` | Session token generation (256-bit), salted SHA-256 hashing at rest, constant-time compare |
| `rbac/` | Permission set definitions (`mouse`, `keyboard`, `clipboard`, `media`, `files`) and validation |

Token handling discipline: the plaintext token exists only in process memory for the
session's lifetime; the device registry persists `tokenHash` + `tokenSalt` only.

## 4. Input Provider API

`@kbm-remote/input-provider` defines controller interfaces consumed by the gateway's frame
router and fulfilled by platform backends through a DI container (`di.ts`):

| Controller | Key operations |
| --- | --- |
| `MouseController` | `moveAbsolute(x,y,dpi)`, `moveRelative(dx,dy)`, `click(button)`, `doubleClick`, `drag{Start,Move,End}`, `scroll(dx,dy)` |
| `KeyboardController` | `pressKey(code)`, `holdKey(code,ms)`, `releaseKey(code)`, `typeText(text)`, `shortcut(modifiers[], key)` |
| `ClipboardController` | `read()`, `write(kind, data)`, event stream for local clipboard changes |

Windows native paths validate all numeric VK codes before command construction and quote
user text with the PowerShell doubling rule; both are covered by captured-command tests.

## 5. Versioning and Compatibility

The protocol version (`v`) is transmitted in every frame and frozen to `1` for the entire
v1.x line. Binary-incompatible changes ship only in a new major release and are signalled
by the receiver with `UnsupportedVersion (0xe0)` when a sender advertises an unrecognised
version. Application semver follows the root `package.json` (currently `1.0.0`).
