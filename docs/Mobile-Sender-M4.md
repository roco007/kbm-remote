# Milestone 4 — Mobile Sender Application (Expo / React Native)

**Repository:** [github.com/roco007/kbm-remote](https://github.com/roco007/kbm-remote) · **Package:** `apps/sender`

The mobile sender now provides the complete control surface defined in the UX
Design Document (§4): eight screens implemented, all wired into a typed React
Navigation stack, backed by Zustand stores and the Material Design 3 theme
system. The milestone delivers the user-facing half of the product; the frames
emitted by every screen are the same binary MessagePack frames documented in
`docs/Protocol-Documentation.md`, and the receiver-side input subsystems that
consume them shipped in Milestone 3.

## Screens Implemented

| Screen            | Route              | UX reference | Key implementation notes                                                                                                                                                                                     |
| ----------------- | ------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Home              | `Home`             | S1           | Device roster, one-tap connect, live connection chip, navigation into all control screens and settings                                                                                                       |
| Pair Device       | `PairDevice`       | S2           | Manual IP/host + port validation, pairing-code entry (fixed length, whitespace-tolerant), validation state feedback                                                                                          |
| Touchpad          | `Touchpad`         | S3           | PanResponder gesture mapping: relative mouse move, zone-based right-click and scroll, two-finger drag with drop release, long-press drag activation, configurable sensitivity                                |
| Keyboard          | `Keyboard`         | S4           | QWERTY grid, hidden `TextInput` batcher flushing accumulated characters as `TextInput` frames (§3.6), Shift/Caps toggles composing as two-key shortcuts, function strip (Esc, Tab, Enter, arrows, Backspace) |
| Media Controls    | `MediaControls`    | S5           | Large transport buttons emitting `MediaKey` frames (§3.4): play/pause, prev/next track, volume up/down, mute                                                                                                 |
| Clipboard         | `Clipboard`        | S6           | Remote clipboard snapshot with refresh (`ClipboardQuery` §3.7), text composer with live byte counter against the `MAX_ITEM_BYTES` cap, resendable local history persisted in AsyncStorage                    |
| Presentation Mode | `PresentationMode` | S8           | Oversized next/previous arrows, slide counter, `expo-keep-awake` activation tied to the "auto-lock screen" setting, session lifecycle bound to the screen                                                    |
| Settings          | `Settings`         | S9           | Touchpad sensitivity, scroll speed, haptics, auto-lock screen, theme selection (system/light/dark) with live preview                                                                                         |

## Architecture

```
apps/sender/src/
├── App.tsx                      # NavigationContainer + Native Stack + store hydration
├── theme.ts                     # M3 token set (light + dark) extending ui-components
├── navigation/
│   ├── types.ts                 # Typed route map (single source of truth)
│   └── HubHeader.tsx            # Reusable M3 top-app-bar with live connection chip
├── screens/                     # All eight screens + registry (index.ts)
├── components/primitives.tsx    # M3Button, M3Card, M3Field, M3IconButton, M3StatusChip
├── services/
│   ├── inputDispatch.ts         # Maps every UI action to protocol frames (fire-and-forget)
│   └── connectionManager.ts     # WSS client lifecycle, typed emitter, resume credentials
├── store/
│   ├── themeStore.ts            # AsyncStorage-persisted theme (system/light/dark)
│   ├── settingsStore.ts         # Sensitivity, scroll speed, haptics, keep-awake
│   ├── connectionStore.ts       # ConnectionManager singleton + paired devices
│   ├── clipboardStore.ts        # Local history, remote snapshot, sync state
│   └── presentationStore.ts     # Session flag + slide counter
└── tests/                       # Unit + integration tests
```

**Navigation.** A single `NativeStackNavigator` with `RootStackParamList` typed
once in `navigation/types.ts`; every `navigate`/`goBack` call is checked by the
compiler. Screen hydration (`hydrateTheme` / `hydrateSettings` /
`hydrateClipboard`) runs before the first render so no screen ever flashes a
stale default.

**State.** Zustand 5 stores with `persist`-style AsyncStorage hydration and
fine-grained selectors (screens subscribe only to the slices they read). The
`connectionStore` owns a lazily-constructed `ConnectionManager` singleton;
`inputDispatch` reads it on every call, so the same helper works identically
from the touchpad gesture loop and the media buttons.

**Input dispatch.** `src/services/inputDispatch.ts` is the single translation
layer between UI and protocol. Each helper (`mouseMove`, `mouseClick`,
`keyPress`, `textInput`, `mediaKey`, `clipboardQuery`, `presentationSlide`,
…) validates connection state, emits a frame envelope without `mid`/`v` (the
network layer injects them per §2.3), and returns a boolean so screens can
surface "not connected" feedback.

**Theme.** `theme.ts` defines the full M3 token set for light and dark
(color roles, elevation surfaces, motion durations) by extending the shared
`ui-components` tokens, so the desktop receiver and mobile sender share one
design language. `useResolvedTokens()` reads the current mode from
`themeStore` and any component can restyle with a single object lookup.

**Motion.** Buttons use `pressed`-state scale transforms (0.93–0.98) with
opacity, and the stack animates with a 220 ms slide — no animation library is
required for the current set of screens, keeping the bundle lean.

## Verification

| Check                           | Result                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| TypeScript (project references) | 0 errors in `apps/sender`                                                                                                     |
| ESLint (src + tests)            | 0 errors, 0 warnings                                                                                                          |
| Sender unit tests               | 17 passing (connection manager integration + 9 new frame-emission tests)                                                      |
| Full monorepo                   | 12 Turbo tasks successful — 15 protocol, 1 auth, 2 ui-components, 95 input-provider, 46 network, 32 receiver, 17 sender tests |

The new `tests/inputDispatch.test.ts` harness swaps the connection store's
manager via `vi.doMock` and asserts the exact envelope shape of every frame
type — button, axis, drag trio, keyboard family, clipboard, and presentation
slide — including the disconnected state and the no-`mid`/no-`v` invariant.

## Known Limits Carried Forward

The sender emits every documented frame, but two wires are completed in the
next milestone: the receiver's inbound frame router currently has no handler
that maps `ClipboardSync` responses back into the sender's `clipboardStore`
(the `setRemote` path is plumbed and ready), and QR-code pairing is declared
in the UX document but the Expo camera dependency was deferred — manual IP
pairing is the active flow. File transfer (S7) remains a later milestone by
design.
