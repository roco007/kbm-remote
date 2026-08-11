# UX Foundation — Design Tokens & Information Architecture

## Product identity

Working name: **KBM Remote** (also surfaced as "Remote Emulator" in tray/menu bar). The product sits in the same category as Unified Remote, KDE Connect, and Deskflow, but its differentiation is a _modern, calm, trustworthy_ aesthetic — it is a security-sensitive control surface, so the design language must communicate precision, privacy, and quiet competence.

## Design principles

1. **Trust is the UI.** Every security-critical state (paired, pinned, revoked, untrusted attempt) has an unambiguous visual state. Nothing about security is hidden in menus.
2. **Primary actions within one hand's reach.** On the sender, the four most-used surfaces (touchpad, keyboard, media, presentation) are always one tab away.
3. **Status is always visible.** The receiver shows connection state in the tray, the status bar, and the dashboard — the user never has to wonder "am I connected?"
4. **Calm by default, detailed on demand.** Logs, latency metrics, and protocol detail live behind deliberate expand actions; they never crowd the primary surfaces.
5. **Symmetry without duplication.** Receiver and sender share one design system (tokens, iconography, motion) so the product feels like one coherent thing.

## Design tokens

| Token            | Light                                                                         | Dark    | Usage                          |
| ---------------- | ----------------------------------------------------------------------------- | ------- | ------------------------------ |
| `bg-app`         | #F7F8FA                                                                       | #0F1115 | App background                 |
| `bg-surface`     | #FFFFFF                                                                       | #181B22 | Cards, sheets                  |
| `bg-elevated`    | #FFFFFF                                                                       | #1F232C | Modals, tooltips               |
| `text-primary`   | #111419                                                                       | #E8EBF1 | Primary text                   |
| `text-secondary` | #6B7280                                                                       | #9AA3B2 | Labels, captions               |
| `accent`         | #4F6EF7 (Indigo)                                                              | #6B84F9 | Primary actions, links         |
| `accent-hover`   | #3D59DB                                                                       | #8097FC | Hover states                   |
| `success`        | #16A34A                                                                       | #22C55E | Connected, allowed             |
| `warning`        | #D97706                                                                       | #F59E0B | Pending, degraded              |
| `danger`         | #DC2626                                                                       | #EF4444 | Disconnected, blocked, revoked |
| `border`         | #E5E7EB                                                                       | #2A2F3A | Dividers                       |
| `radius-md`      | 12px                                                                          |         | Cards                          |
| `radius-lg`      | 16px                                                                          |         | Sheets, large surfaces         |
| `radius-pill`    | 999px                                                                         |         | Chips, buttons                 |
| `font-stack`     | Inter (UI) / SF Pro / Segoe UI system fallback; JetBrains Mono for codes/keys |         |                                |

Motion: 150–250 ms ease-out for micro-interactions; 300 ms for sheet slide-ins; reduced-motion respected on both platforms.

## Information architecture

### Desktop receiver (Electron window + system tray)

```
Receiver
├── Tray / Menu bar icon (always present, OS-native)
│   ├── Quick status (device name, connection count)
│   ├── Show app
│   ├── Generate new pairing code
│   └── Quit / minimize to tray
├── Window (frameless-feel, 960×640 min)
│   ├── Sidebar (collapsible, 240px)
│   │   ├── Dashboard
│   │   ├── Devices
│   │   ├── Pairing
│   │   ├── Permissions
│   │   ├── Settings
│   │   └── Logs
│   ├── Content area
│   └── Global status strip (bottom, 32px)
└── Onboarding (first-run, replaces window until completed)
```

### Mobile sender (React Native, bottom-tab shell)

```
Sender
├── Tab shell (5 tabs)
│   ├── Devices (home — list of paired receivers, discover)
│   ├── Touchpad
│   ├── Keyboard
│   ├── Media
│   └── Settings (account, appearance, about)
├── Contextual surfaces
│   ├── Presentation mode (full-screen overlay launched from Devices)
│   ├── Clipboard manager (sheet from Touchpad)
│   ├── File transfer (screen from Devices → transfer flow)
│   ├── Pairing flow (modal stack: QR scan / code / PIN)
│   └── Device detail (sheet from Devices list)
└── Light & dark mode (follows system; manual override in Settings)
```
