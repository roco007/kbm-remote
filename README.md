# KBM Remote

A production-grade remote keyboard and mouse emulator for the local network.
A secure desktop receiver (Electron + NestJS) is controlled by a mobile
sender (Expo / React Native) over a single TLS-protected WebSocket connection.

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
├── .github/workflows/     # CI — lint, typecheck, test, build
└── docs/                  # Architecture · Tech Evaluation · UX · Protocol specs
```

## Prerequisites

| Tool    | Minimum version |
| ------- | --------------- |
| Node.js | 22.x (LTS)      |
| pnpm    | 10.x            |
| git     | 2.x             |

The root `package.json` declares `engines.node >= 20`; Node 22 is recommended
for full `node:quic` evaluation headroom in future milestones.

## Setup

```bash
pnpm install        # installs all workspaces + Electron postinstall binaries
pnpm dev            # starts receiver + sender watch modes in parallel
pnpm build          # full monorepo build (Turbo, ordered by dependencies)
pnpm test           # unit tests across all workspaces
pnpm lint           # ESLint across all workspaces
pnpm typecheck      # project-references-based typechecking
pnpm format         # Prettier fix
```

The `apps/*` packages depend on `packages/*` via workspace references, so
`pnpm install` wires everything automatically — no symlinking needed.

## Development Conventions

Commits must follow [Conventional Commits](https://www.conventionalcommits.org)
with scopes enforced by commitlint:

```
<type>(<scope>): <subject>
# type : feat | fix | docs | style | refactor | perf | test | build | ci | chore
# scope: receiver | sender | protocol | network | auth | input | ui | repo | deps | ci
```

Husky runs `lint-staged` (ESLint + Prettier) on staged files and commitlint on
every commit before push. CI (GitHub Actions) blocks merges that fail lint,
typecheck, tests, or builds.

## Documentation

Authoritative design artifacts live in `docs/` (copied from the design phase):

- **Architecture Design Document** — modules, data flow, security model
- **Technology Evaluation Report** — input/network/discovery decisions
- **UX Design Document** — screen specs and wireframes for both apps
- **Protocol Documentation** — the wire contract every package implements

## Roadmap

| Milestone | Scope                                                       |
| --------- | ----------------------------------------------------------- |
| M0        | Monorepo scaffold (this commit)                             |
| M1        | Auth package + pairing codes + session tokens               |
| M2        | Protocol codec + WSS client/server + heartbeat/RTT          |
| M3        | Input provider (nut.js default + native fallbacks)          |
| M4        | mDNS/UDP-beacon discovery, reconnect, multi-monitor mapping |
| M5        | Receiver dashboard (R1–R12) + sender screens (S1–S11)       |
| M6        | Hardening, E2E tests, release packaging                     |

## License

Proprietary — all rights reserved.
