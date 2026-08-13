# Milestone 5 — Electron Desktop Receiver (Dashboard UI)

**Status: complete · commit on `master` · receiver task suite 38/38 passing · monorepo CI 12/12 green**

This milestone converts the receiver from a headless NestJS service into a full
desktop application: an Electron shell with a system tray, OS auto-start, and a
Material Design 3 dashboard built with React, Zustand and a context-isolated
preload bridge. The NestJS WebSocket server from Milestones 2–3 is unchanged and
is now driven by the UI.

---

## 1. Architecture

```
apps/receiver/
├── src/main/                 # Node main process (privileged)
│   ├── index.ts              # Electron shell: window, tray, auto-start, IPC
│   ├── settingsStore.ts      # JSON-persisted AppSettings (createSettingsStore)
│   ├── deviceRegistry.ts     # Trusted devices, pending approvals, permissions
│   ├── logBuffer.ts          # Rolling ring buffer (cap 2 000) for diagnostics
│   └── networkService.ts     # NestJS WSS host (existing, now UI-driven)
├── src/preload/index.ts      # contextBridge → window.kbmReceiver typed API
├── src/renderer/             # React dashboard (browser context)
│   ├── theme.ts              # M3 tokens extending ui-components light/dark
│   ├── primitives.tsx        # Card, Button, Switch, Select, Sidebar, Tabs…
│   ├── store.ts              # Zustand store mirroring the preload API
│   ├── index.tsx             # App shell + route state
│   ├── index.html            # CSP-hardened entry (served from dist/renderer)
│   └── screens/              # Dashboard, Pairing, Permissions, Logs, Settings
├── esbuild.renderer.mjs      # Renderer bundle (IIFE, one-shot + watch modes)
└── tests/                    # Vitest — network, input service, registry, buffer
```

The design follows the same clean boundary as the sender app: the main process
never touches UI concerns, the renderer never touches `electron`/`fs`/`net`, and
all communication flows through the typed preload bridge (`ReceiverApi`).

### Main process responsibilities

| Concern            | Implementation                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Window lifecycle   | 1120×720 frameless-capable window with devtools flag via env                                                                          |
| System tray        | `Tray` with status-aware context menu (listening / error), show/hide window                                                           |
| Auto-start         | `app.getLoginItemSettings()` mirrored to the `autoStart` setting on change                                                            |
| Close-to-tray      | `close` event cancelled when `closeToTray` is true; real quit via tray menu                                                           |
| IPC surface        | `settings:*`, `service:start/stop/status`, `devices:list/pending/approve/revoke/…`, `pairing:code`, `logs:tail`, `shell:openExternal` |
| Events to renderer | `serviceStateChanged`, `devicesChanged`, `settingsChanged`                                                                            |

### Preload bridge

```ts
window.kbmReceiver: {
  settings: { get, update },
  service: { status, start, stop, onStateChanged },
  devices: { list, pending, approve, revoke, setPermissions, onChanged },
  pairing: { code },                       // fresh 6-digit code + QR payload
  sessions: { list },                      // live gateway sessions (monitoring)
  logs: { tail },                          // newest-first log slice
  shell: { openExternal },
  onSettingsChanged(callback)              // cleanup function returned
}
```

---

## 2. Screens (Material Design 3)

| Screen          | Behaviour                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard**   | Device list (trust status, per-device permissions), live session grid with byte counters, round-trip time and latency, start/stop service control, status chip |
| **Pairing**     | 6-digit code display (5-min TTL, refresh), QR rendering via `qrcode` (`kbmremote://pair/<code>`), pending-request queue with Approve/Deny, manual code verify  |
| **Permissions** | One card per trusted device; toggles for the six protocol scopes (mouse, keyboard, clipboard, media, presentation, fileTransfer); instant revocation           |
| **Logs**        | Live auto-tailing ring buffer, filter by level (info/warn/error) and category, manual refresh                                                                  |
| **Settings**    | Device ID, port (apply & restart service), theme (system/light/dark), auto-start and close-to-tray switches                                                    |

### Theme system

The renderer tokens extend the shared `ui-components` `lightTheme`/`darkTheme`
(M3 primary, secondary, surface, on-*, elevation) with additional keys
(`bgElevated`, `onSurfaceVariant`, `outline`, `focusRing`, `motion`) exposed as
CSS custom properties by `<TokenProvider mode>`. `"system"` resolves
`prefers-color-scheme`. Transitions use the M3 motion tokens (`ease-out`,
`250ms`) so route changes, toggles and list updates animate consistently.

---

## 3. Verification

| Check                                    | Result                                                      |
| ---------------------------------------- | ----------------------------------------------------------- |
| `pnpm -F @kbm-remote/receiver typecheck` | 0 errors (incl. JSX, DOM lib, strict)                       |
| `pnpm -F @kbm-remote/receiver lint`      | 0 errors, 1 intentional console warning                     |
| `pnpm -F @kbm-remote/receiver test`      | 38/38 (app, inputService, networkService, **electronMain**) |
| `pnpm test` (monorepo)                   | 12/12 Turbo tasks cached-green                              |
| `pnpm build`                             | tsc → dist + esbuild bundle (190 KB IIFE) + index.html      |

New test coverage (`tests/electronMain.test.ts`): settings persistence and
merge semantics, pairing-code generation/verification, pending-queue cap of 5,
approval → trusted list transition with event emission, per-device permission
updates, `toAuthStore()` token verification, and ring-buffer tail semantics.

---

## 4. Running the receiver

```bash
pnpm build            # compile + bundle renderer
pnpm start            # electron dist/main/main.js
```

Settings persist at `~/.kbm-remote/settings.json`; trusted devices at
`~/.kbm-remote/devices.json`. Port changes require _Apply & restart_ from the
Settings screen; everything else applies live.

---

## 5. Forward wires (intentional)

The renderer currently reads session metrics from the gateway snapshot; the
pairing screen's "deny" path uses revocation semantics. The frame router that
maps `permissionDenied` to the sender remains a Milestone 6 hardening item.
Tray icon art is placeholder (platform template icon) — real brand assets ship
with Milestone 6 release packaging.
