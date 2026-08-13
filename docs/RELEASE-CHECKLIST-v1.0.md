# Version 1.0 Release Checklist — KBM Remote

This checklist gates the `v1.0.0` release. Items marked **[verified]** have been confirmed
against this codebase as of this commit; items marked **[CI]** are verified by the release
workflow on GitHub Actions; items marked **[manual]** must be performed on real hardware
by a maintainer before or after the tag is published.

## 1. Code Quality and CI

| # | Item | Status |
| --- | --- | --- |
| 1.1 | All workspaces typecheck under strict TypeScript | [verified] |
| 1.2 | ESLint and Prettier clean across the monorepo | [verified] |
| 1.3 | Full unit test suite green (222 tests, six workspaces) | [verified] |
| 1.4 | `ci.yml` runs on every push/PR to `master` with format, lint, typecheck, test, audit, and per-app build jobs | [verified] |
| 1.5 | Husky + lint-staged + commitlint enforce style and Conventional Commits locally | [verified] |
| 1.6 | No secrets (tokens, keys, certificates) committed to the tree | [verified] |
| 1.7 | Versions bumped to `1.0.0` in all eight `package.json` files | [verified] |
| 1.8 | Protocol version frozen at `v = 1` for the v1.x line; mismatched senders receive `UnsupportedVersion` | [verified] |

## 2. Security (Milestone 7 baseline — no regressions allowed)

| # | Item | Status |
| --- | --- | --- |
| 2.1 | Challenge-response authentication (96-bit one-time challenge, echo in Authenticate) | [verified] |
| 2.2 | Certificate pinning on the sender; TOFU fingerprint capture at pairing; `certPinFailed` aborts before any input frames | [verified] |
| 2.3 | Receiver TLS identity persisted across restarts (stable fingerprint) | [verified] |
| 2.4 | Session tokens hashed at rest (salted SHA-256, constant-time compare) | [verified] |
| 2.5 | Uniform-random pairing codes; pending devices hold zero permissions | [verified] |
| 2.6 | Rate limiting: pre-auth ping watchdog, auth timeout, per-IP caps, auth-failure ban window, sliding-window limits | [verified] |
| 2.7 | Replay guard: per-session `seenMids` deduplication | [verified] |
| 2.8 | DEFLATE zip-bomb protection (4 MiB inflate cap) | [verified] |
| 2.9 | Win32 command construction validated and quote-escaping covered by captured-command tests | [verified] |
| 2.10 | `pnpm audit` shows no runtime-reachable vulnerabilities (Electron `^42.9.0`; remaining findings are transitive build/mobile toolchain only) | [verified] |
| 2.11 | No new dependency added without maintainer discussion | [manual] |

## 3. Installers and Distribution

| # | Item | Status |
| --- | --- | --- |
| 3.1 | `release.yml` builds the receiver on `windows-latest`, `macos-latest`, and `ubuntu-latest` | [CI] |
| 3.2 | Windows artifacts: NSIS installer + portable ZIP | [CI] |
| 3.3 | macOS artifacts: DMG + ZIP (universal) | [CI] |
| 3.4 | Linux artifacts: AppImage + deb | [verified] locally |
| 3.5 | Release is created as a **draft** with release notes generated, then reviewed and published | [CI/manual] |
| 3.6 | App icons present in `apps/receiver/build/` (electron-builder uses its default if absent — consider adding a branded icon before shipping) | [manual] |
| 3.7 | Mobile sender distributed via Expo development builds (`pnpm --filter @kbm-remote/sender run android`); EAS production builds deferred to M8 | [verified] |

## 4. Smoke Tests (real hardware)

| # | Item | Status |
| --- | --- | --- |
| 4.1 | Receiver starts from installer, shows tray icon, and listens on the configured port | [manual] |
| 4.2 | QR / pairing-code pairing completes end-to-end on LAN (both devices) | [manual] |
| 4.3 | Mouse (move, click, scroll, drag), keyboard, media, and clipboard flow correctly after pairing | [manual] |
| 4.4 | Multi-monitor cursor handling correct on a two-display setup | [manual] |
| 4.5 | Reconnection, heartbeat, and RTT metrics behave correctly across network churn | [manual] |
| 4.6 | Device approval/rejection and revocation work in the dashboard | [manual] |
| 4.7 | Startup time and memory footprint acceptable (receiver idle footprint under ~300 MB target) | [manual] |

## 5. Documentation

| # | Item | Status |
| --- | --- | --- |
| 5.1 | `README.md` covers features, pairing, security, docs index, and installation | [verified] |
| 5.2 | `docs/Architecture-Overview.md` and `docs/Architecture-Design-Document.md` current | [verified] |
| 5.3 | `docs/API-Documentation.md` matches the wire protocol and package APIs | [verified] |
| 5.4 | `docs/Protocol-Documentation.md` and `docs/Security-Audit-M7.md` preserved | [verified] |
| 5.5 | `docs/Developer-Guide.md` and `docs/Contribution-Guide.md` current | [verified] |
| 5.6 | `LICENSE` present (proprietary) and consistent with the README | [verified] |

## 6. Known Issues and Follow-ups (M8 backlog)

The release ships with these documented limitations, each tracked for the next milestone:
certificate pinning on the React Native sender is infrastructure-level with runtime behaviour
planned for M8; session tokens have no expiry/TTL yet (rolling re-authentication planned);
discovery messages are not signed (pairing code still required); `apps/receiver/tls/` generated
identity files must never be committed; iOS sender support and EAS production builds are
deferred; remote file transfer, Wake-on-LAN, screen sharing, and the plugin architecture
remain on the roadmap.
