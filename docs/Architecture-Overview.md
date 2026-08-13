# Architecture Overview — KBM Remote v1.0

This document provides a production-oriented overview of the KBM Remote system: its
components, the flow of data from a gesture on the phone to an input event on the desktop,
its deployment topology, and the module boundaries that keep the system maintainable. For
the complete clean-architecture design (layers, dependency rules, repository pattern) see
[`Architecture-Design-Document.md`](./Architecture-Design-Document.md).

## 1. Component Map

```
┌─────────────────────────────┐                 ┌─────────────────────────────────┐
│  Sender (Expo / React Native)│                 │  Receiver (Electron + NestJS)   │
│                             │                 │                                 │
│  Touchpad / Keyboard /      │   TLS WSS       │  NestJS WebSocketGateway        │
│  Clipboard screens          │◄───────────────►│  (WssGateway — flood & replay   │
│  ConnectionManager          │   MsgPack+DEFL  │   protected, challenge-response)│
│  (cert pinning, session)    │                 │                                 │
│                             │                 │  FrameRouter ── controllers ────│
│  Zustand stores             │                 │  Mouse / Keyboard / Clipboard   │
│  React Navigation           │                 │                                 │
└─────────────────────────────┘                 │  InputProvider (DI) ── backends │
                                                │  (nut.js default; native Win32/ │
┌─────────────────────────────┐                 │   macOS/Linux via OS APIs)      │
│  packages/protocol          │                 │                                 │
│  packages/network           │  shared between │  DeviceRegistry (RBAC, hashed   │
│  packages/auth              │  both apps      │  tokens), NetworkService        │
│  packages/ui-components     │                 │  System tray, mDNS, settings    │
└─────────────────────────────┘                 └─────────────────────────────────┘
```

The two applications share five pure-TypeScript packages that own all contract and
infrastructure code, so the wire protocol, cryptography, and input abstractions are
identical on both sides of the connection by construction.

| Package                      | Responsibility                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@kbm-remote/protocol`       | Frame types, MsgPack codec with DEFLATE compression (FastCodec, 4 MiB inflate cap), validation schemas, protocol versioning         |
| `@kbm-remote/network`        | `WssGateway` (server), `ClientConnection` (client), heartbeat and RTT metrics, mDNS discovery, frame coalescing                     |
| `@kbm-remote/auth`           | TLS certificate handling, pairing codes, session tokens, RBAC permission sets — dependency-free core TypeScript                     |
| `@kbm-remote/input-provider` | Input abstraction layer (`MouseController`, `KeyboardController`, `ClipboardController`) with dependency-injected platform backends |
| `@kbm-remote/ui-components`  | Material Design 3 design tokens (light/dark) shared by receiver UI and mobile sender                                                |

## 2. Data Flow

A mouse movement follows this path:

1. The sender's `Touchpad` screen translates the gesture into a `MouseMove` frame via
   `ConnectionManager.send()`.
2. The frame passes through `FrameCoalescer`, which drops superseded motion frames when the
   network cannot keep up — guaranteeing smooth motion without unbounded queue growth.
3. `ClientConnection` encodes the frame with the shared codec (MsgPack + DEFLATE) and writes
   it to the TLS socket.
4. `WssGateway` receives, decompresses (under the 4 MiB cap), validates the schema, checks
   the session's replay guard (`seenMids`), and forwards the frame to the
   `MouseController` via the frame router.
5. The controller translates logical coordinates into physical screen coordinates
   (multi-monitor aware) and dispatches them through the injected backend (nut.js by
   default; `Win32MouseBackend`, `DarwinMouseBackend`, `X11MouseBackend` for native paths).
6. Latency is measured end-to-end with Ping/Pong round-trips and surface as the RTT metric
   shown in the receiver dashboard.

Authentication interleaves with this flow: `Hello` → `HelloAck` (with one-time 96-bit
challenge) → `Authenticate` (echoes the challenge; sender pins the server certificate
before any input frame flows) → `AuthOk`. A failed pin fires `certPinFailed`, aborts the
handshake, and surfaces an impersonation warning in the UI.

## 3. Deployment Topology

The receiver runs as a single Electron process with the NestJS gateway hosted in-process,
listening on a configurable port (default 9840) over self-signed TLS. Its identity
(key/certificate) is generated once and persisted under `userData/identity/`, so the sender's
pinned fingerprint stays stable across restarts. Discovery uses mDNS (`_kbmremote._tcp`) so
senders on the same LAN find the receiver without manual configuration; pairing is still
required even after discovery, and pending devices receive **no permissions** until approved.

| Component | Install path                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| Receiver  | Windows NSIS installer / portable ZIP, macOS DMG / ZIP, Linux AppImage / deb                                     |
| Sender    | Expo development builds (`pnpm --filter @kbm-remote/sender run android/ios`); EAS production builds planned (M8) |
| CI        | GitHub Actions — `ci.yml` (quality + build on PRs) and `release.yml` (tagged multi-platform installers)          |

## 4. Extension Points

Production extensibility is delivered through four boundaries. New **frame types** are added
in `packages/protocol/src/types/` with a frozen numeric discriminator and a validation schema
(`packages/protocol/src/validation`); both sides must upgrade together because the type table
is frozen for the v1.x line. New **input backends** implement the controller interfaces and
are registered with the DI container (`packages/input-provider/src/di.ts`) without touching
the network layer. New **permissions** extend the RBAC set in `packages/auth/src/rbac`, and
new **discovery transports** plug into the discovery module's strategy interface in
`packages/network`.

A plugin architecture is listed as a nice-to-have; the package boundaries above make a
formal plugin API a later evolution rather than a v1.0 requirement.

## 5. Quality Gates

Every change must pass the CI pipeline: ESLint + Prettier (Husky/lint-staged locally),
strict TypeScript typechecking across the whole reference graph, and 222 unit tests across
the six workspaces. Dependency audits are run on every quality pass, and the security audit
of Milestone 7 (15 findings, all fixed) is preserved in [`Security-Audit-M7.md`](./Security-Audit-M7.md).
