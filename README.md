# KBM Remote

**Version 1.0** · A production-grade remote keyboard and mouse emulator for the local network.

KBM Remote lets a mobile device (Android today, iOS later) control a desktop computer over
the local network. A secure desktop **receiver** built with Electron and NestJS accepts
connections from a **sender** application built with Expo and React Native. All traffic flows
through a single TLS-protected WebSocket connection authenticated with pairing codes,
certificate pinning, and challenge-response sessions.

| | |
| --- | --- |
| Receiver | Electron 42 + NestJS 11 · Windows, macOS, Linux |
| Sender | Expo 53 / React Native 0.79 · Android (iOS planned) |
| Protocol | Binary MessagePack frames over WSS, MsgPack-compressed with DEFLATE |
| Security | TLS + cert pinning, pairing codes, challenge-response auth, RBAC permissions |
| Monorepo | pnpm workspaces + Turborepo · TypeScript 5.8 · ESLint + Prettier + Husky |

## Features

The receiver emulates keyboard input (printable, function, media keys, modifiers, shortcuts,
unicode, long-press and key repeat), mouse input (absolute and relative movement, left/right/
middle click, double click, drag-and-drop, vertical and horizontal scroll) across multiple
displays, and synchronises clipboard text and images in both directions. Media control
commands cover volume up/down/mute and playback transport (play/pause, previous, next track).

Security is enforced at every layer. Devices are introduced through QR-code or manual pairing
codes, trusted devices are managed with revocation, session tokens are salted and hashed at
rest, TLS certificates are pinned on the sender (TOFU bootstrapped from the pairing scan), and
the gateway rate-limits both unauthenticated flooding and repeated authentication failures.
DEFLATE payloads are decompressed under a 4 MiB ceiling, and native input paths validate
their inputs before reaching the shell.

## Repository Layout

```
kbm-remote/
├── apps/
│   ├── receiver/          # Electron desktop receiver (NestJS server in-process)
│   └── sender/            # Expo React Native mobile sender
├── packages/
│   ├── protocol/          # Wire contract — types, codec, validation (the shared API)
│   ├── network/           # WSS client/server, heartbeat, RTT metrics, discovery
│   ├── auth/              # Certs, pairing codes, session tokens, RBAC (pure TS)
│   ├── input-provider/    # Receiver-side input abstraction (nut.js / native APIs)
│   └── ui-components/     # Shared design system (light/dark tokens)
├── .github/workflows/     # CI (quality + build) and release (tagged installers)
└── docs/                  # Architecture · Protocol · API · Security · UX · Guides
```

## Quick Start

### Prerequisites

| Tool | Minimum version |
| --- | --- |
| Node.js | 22.x LTS |
| pnpm | 10.x |
| git | 2.x |

The root `package.json` declares `engines.node >= 20`; Node 22 is recommended for the Electron
42 runtime and future protocol headroom.

### Clone and Install

```bash
git clone https://github.com/roco007/kbm-remote.git
cd kbm-remote
pnpm install        # installs all workspaces + Electron postinstall binaries
```

### Run in Development

```bash
pnpm dev            # receiver + sender watch modes in parallel
pnpm build          # full monorepo build (Turborepo, dependency-ordered)
pnpm test           # unit tests across all workspaces (222 tests)
pnpm lint           # ESLint across all workspaces
pnpm typecheck      # project-references-based typechecking
pnpm format         # Prettier fix
```

The `apps/*` packages depend on `packages/*` via workspace references, so `pnpm install`
wires everything automatically — no symlinking needed.

### Run the Receiver in Production

```bash
pnpm build
pnpm --filter @kbm-remote/receiver run start
```

The receiver opens in the system tray, advertises itself via mDNS, and displays a pairing
QR code. Scan it from the sender app to connect.

## Pairing and Connecting

Pairing uses a **challenge–response** flow over the TLS channel. The receiver prints a
short-lived QR code encoding its `wss://` endpoint and a random pairing code; the sender
scans it, opens the WebSocket, exchanges `Hello` / `HelloAck` (including a one-time 96-bit
auth challenge), and completes `Authenticate` with a `sessionId` + `sessionToken`. The owner
then approves the pending device in the receiver dashboard; only approved devices receive
permissions. Subsequent connections reuse the stored session and validate the receiver's
certificate against the pinned fingerprint captured at first pairing (TOFU).

Manual pairing is identical but with a typed code. Pairing codes are uniform-random
(`randomBytes`), single-use, and rotated per session — see the security audit below.

## Security Model

The security posture is documented in full in [`docs/Security-Audit-M7.md`](docs/Security-Audit-M7.md)
(the Milestone 7 audit, which fixed all 15 identified findings in code). Highlights:

| Layer | Defence |
| --- | --- |
| Transport | WSS + self-signed TLS identity persisted in `userData`; sender certificate pinning (TOFU) |
| Authentication | Challenge-response handshake; one-time 96-bit challenges, 30 s window |
| Replay | Per-session `seenMids` deduplication for every reliable frame |
| Rate limiting | Pre-auth ping watchdog, auth timeout, per-IP connection caps, sliding-window auth throttling |
| Secrets | Session tokens salted SHA-256 at rest; constant-time verification |
| Injection | Numeric-only VK codes; PowerShell single-quote doubling proven by captured-command tests |
| DoS | DEFLATE decompression cap (4 MiB); unauthenticated traffic throttled |
| Permissions | Pending/unapproved devices receive no permissions; owner-configurable RBAC |

## Documentation

| Document | Purpose |
| --- | --- |
| [`docs/Architecture-Overview.md`](docs/Architecture-Overview.md) | System architecture, module map, data flow, deployment topology |
| [`docs/API-Documentation.md`](docs/API-Documentation.md) | Wire protocol, network client/server APIs, auth APIs |
| [`docs/Developer-Guide.md`](docs/Developer-Guide.md) | Workspace layout, build system, extending the protocol, debugging, testing |
| [`docs/Contribution-Guide.md`](docs/Contribution-Guide.md) | Branching, conventional commits, pull-request and review process |
| [`docs/Protocol-Documentation.md`](docs/Protocol-Documentation.md) | Wire contract specification (every frame, handshake, heartbeat) |
| [`docs/Security-Audit-M7.md`](docs/Security-Audit-M7.md) | Security audit findings, remediations, residual risks |
| [`docs/Architecture-Design-Document.md`](docs/Architecture-Design-Document.md) | Full architecture design (modules, DI, clean architecture) |
| [`docs/Technology-Evaluation-Report.md`](docs/Technology-Evaluation-Report.md) | Technology choices and justification |
| [`docs/UX-Design-Document.md`](docs/UX-Design-Document.md) | Screen specs and wireframes for both apps |
| [`docs/Optimization-Benchmarks-M6.md`](docs/Optimization-Benchmarks-M6.md) | FastCodec, adaptive heartbeats, input coalescing benchmarks |
| [`docs/RELEASE-CHECKLIST-v1.0.md`](docs/RELEASE-CHECKLIST-v1.0.md) | Version 1.0 release checklist |

Subsystem design notes: [`Mouse-Subsystem-M3a.md`](docs/Mouse-Subsystem-M3a.md),
[`Keyboard-Subsystem-M3b.md`](docs/Keyboard-Subsystem-M3b.md),
[`Clipboard-Subsystem-M3c.md`](docs/Clipboard-Subsystem-M3c.md),
[`Mobile-Sender-M4.md`](docs/Mobile-Sender-M4.md), [`Receiver-UI-M5.md`](docs/Receiver-UI-M5.md).

## Releases and Installers

Tagged releases publish desktop installers through the `release` workflow: **Windows**
(NSIS installer + portable ZIP), **macOS** (DMG + ZIP), and **Linux** (AppImage + deb).
Pre-built binaries are attached to each GitHub release. To build installers locally:

```bash
pnpm --filter @kbm-remote/receiver run build
pnpm --filter @kbm-remote/receiver run dist      # builds for the current platform
```

Cross-platform builds run on the CI runners (see [`docs/Developer-Guide.md`](docs/Developer-Guide.md)).

## Development Conventions

Commits must follow [Conventional Commits](https://www.conventionalcommits.org) with scopes
enforced by commitlint:

```
<type>(<scope>): <subject>
# type : feat | fix | docs | style | refactor | perf | test | build | ci | chore
# scope: receiver | sender | protocol | network | auth | input | ui | repo | deps | ci
```

Husky runs `lint-staged` (ESLint + Prettier) on staged files and commitlint on every commit
before push. CI (GitHub Actions) blocks merges that fail lint, typecheck, tests, or builds.

## Roadmap

| Milestone | Scope |
| --- | --- |
| M0 | Monorepo scaffold |
| M1 | Auth package — pairing codes, session tokens, RBAC |
| M2 | Protocol codec + WSS client/server, heartbeat/RTT |
| M3 | Input provider — mouse, keyboard, clipboard subsystems |
| M4 | Mobile sender — 8 screens, Zustand, React Navigation |
| M5 | Electron receiver dashboard — tray, auto-start, pairing, permissions, logs |
| M6 | Performance — FastCodec, adaptive heartbeats, input coalescing |
| M7 | Security audit — all 15 findings fixed, Electron 42, pinning, rate limiting |
| **v1.0** | Production packaging — CI, release workflow, installers, documentation |
| M8 | iOS sender, token TTL + rolling re-authentication, discovery-message signing |

## License

Proprietary — all rights reserved. See [`LICENSE`](LICENSE).
