# M4 — React Native sender app: task state

## User request

React Native mobile sender with pages: Home, Touchpad, Keyboard, Media Controls,
Clipboard, Presentation Mode, Settings, Pair Device. Material Design 3, smooth
animations, React Navigation, Zustand, dark mode.

## Monorepo facts (verified)

- apps/sender already scaffolded: Expo ~53, RN 0.79.2, React 19, package
  "@kbm-remote/sender" with scripts dev/ios/android/build/lint/typecheck/test
  (vitest). src has App.tsx (stub, return null), screens/components/services/store
  dirs with placeholder files (connectionManager.ts 154 lines real, gestureMapper
  placeholder). Existing note: "Expo router will be wired in M5".
- Dependencies avail: @kbm-remote/protocol, network, auth, ui-components
  (workspace:*), expo-secure-store, ws, @msgpack/msgpack, expo.
- packages/network/src/client/ClientConnection.ts: public API —
  constructor(options: ClientOptions {url,...}), .connect(), .dispose(),
  .setUrl(url), .send(frame: Omit<FrameEnvelope,"mid"|"v">) fire-and-forget,
  .sendReliable(frame) → Promise<FrameResult>, .state, .sessionId,
  .events: ClientEvents {stateChange?(state), message?(envelope), ...}
  (check src around line 70-105 for full ClientEvents keys).
- packages/protocol/src/types/index.ts: FrameType const (Hello 0x01 ...
  PresentationSlide 0xb0, DisplayQuery 0xc0, ClipboardSync 0x70,
  ClipboardQuery 0x71, KeyPress 0x50 ... MediaKey 0x60, MouseMove 0x40 etc.)
  FrameEnvelope { t, mid, v, ts?, p }.
- packages/auth: pairing (8-char code, HMAC), session tokens; mostly placeholder.

## Design decisions for M4

- Stack: Expo SDK 53 (existing), expo-router NOT required — user asked for
  React Navigation (user requirement wins). Use @react-navigation/native +
  @react-navigation/native-stack (stack nav) + optional bottom tabs in Touchpad
  screen itself? Keep simple: single stack navigator, 8 screens.
- State: Zustand stores: useConnectionStore (devices, connection state),
  useThemeStore (dark/light/system), usePresentationStore (slide index),
  useClipboardStore. Persist devices via AsyncStorage (use
  @react-native-async-storage/async-storage — add to package.json dev/prod? It's
  Expo default: add to deps).
- Theme: M3 token set in packages/ui-components already? Check
  packages/ui-components/src. Build theme.ts in sender with MD3 colors
  (primary 0xFF6750A4-ish purple; tonal; dark bg 121212/1C1B1F).
- Animations: react-native-reanimated not installed; use core Animated API
  (already in RN). Press feedback scale 0.97, fade-ins 250ms.
- Touchpad: PanResponder → relative mouse frames (dx/dy), tap → click,
  2-finger scroll not needed (use swipe zones or pinch? keep: single touch move,
  tap, two-finger scroll via Gesture? Simpler: PanResponder + scroll via
  two-finger not trivial; implement vertical scroll zone (right-side 20% swipe)).
- Keyboard: QWERTY grid rows with letters, modifier keys (Shift caps toggle,
  symbol switcher), modifier-state buttons (Ctrl/Alt/Meta/Arrow cluster),
  TextField with TextInput → TextInput frames (debounced batches), special keys.
- Media: big buttons volume up/down/mute, play/pause, prev/next (MediaKey frame 0x60).
- Clipboard: recent uploads list (client-side history), send clipboard (upload),
  pull from receiver (ClipboardQuery), display last synced.
- Presentation: slide counter (next/prev via PresentationSlide 0xb0), enter/exit,
  useKeepAwake from expo-keep-awake, wake-lock.
- Pair Device: scan (mDNS placeholder — network discovery client exists? check
  packages/network/src/discovery), manual IP + port, pairing code entry
  (8-char), show QR? (expo-image-manipulator unnecessary; skip QR for now, note).
- Home: device list (paired + trusted), connect/disconnect, status chip,
  navigate to hub once connected.
- Settings: theme toggle, pointer speed, scroll sensitivity, haptics, about.
- CI: add sender to turbo pipeline? typecheck via tsc -p tsconfig.json (build
  uses tsconfig.build.json). Add vitest unit tests for gestureMapper, theme,
  stores (pure logic). Lint eslint src --ext .ts,.tsx.
- Verification env: no iOS/Android emulator available; run `npx tsc`, lint,
  vitest, and `npx expo export --platform web` style check via `tsc` only.
  Note limitations in docs.

## Progress

- [ ] Phase 1 scaffold: add deps (zustand, react-navigation/native, native-stack,
      reanimated? no — use core Animated, react-native-gesture-handler needed for
      navigation) to apps/sender/package.json; pnpm install; configure babel.
- [ ] Phase 2: theme, navigation root, stores, screens Home/Pair/Settings.
- [ ] Phase 3: Touchpad/Keyboard/Media/Clipboard/Presentation.
- [ ] Phase 4: typecheck+lint+tests green; expo doctor pass if possible.
- [ ] Phase 5: docs/Sender-App-M4.md, commit, zip, deliver.

## Verified API surfaces (for compaction safety)

### ConnectionManager (apps/sender/src/services/connectionManager.ts, REAL)

- Constructor: `new ConnectionManager({ clientName, clientOs: "android"|"ios",
socketFactory, resume?: {sessionId, sessionToken} })`
- Methods: connect(address: {url, source: "mdns"|"manual"|"stored"}),
  disconnect() (graceful), dispose(); getters: state, sessionId, address,
  connectionRef (raw ClientConnection)
- Events (extends ClientEvents): stateChange, helloAck(payload),
  authOk(payload), authFailed(payload), message(frame: FrameEnvelope),
  reconnecting(attempt). Emitter.on(event, fn) → unsubscribe fn.
- ClientConnection: connectionState (ClientState), send(frame),
  sendReliable(frame) → FrameResult, sessionId.

### ui-components (packages/ui-components/src/theme)

- lightTheme/darkTheme tokens: bgApp, bgSurface, textPrimary, textSecondary,
  accent (#4F6EF7/#6B84F9), success, warning, danger, border, radiusMd/Lg.
  motion {microMs:200, sheetMs:300, easing}. Barrel also exports
  UI_COMPONENTS_PLACEHOLDER=true.

### Protocol

- FrameType const keys: MouseMove 0x40, MouseClick 0x41, MouseScroll 0x42,
  MouseDragStart 0x43, MouseDragMove 0x44, MouseDragEnd 0x45, KeyPress 0x50,
  KeyHold 0x51, KeyRelease 0x52, TextInput 0x53, Shortcut 0x54, MediaKey 0x60,
  ClipboardSync 0x70, ClipboardQuery 0x71, PresentationSlide 0xb0,
  DisplayQuery 0xc0, Hello 0x01, Disconnect 0xd0, PairRequest 0x10 etc.
- FrameEnvelope { t, mid, v, ts?, p }. tsconfig.build.json extends tsconfig.json
  with declaration output, excludes tests.
- Discovery placeholder exists (packages/network/src/discovery — TODO M4).
  mDNS NOT implemented — sender app uses manual IP+port entry (document this).

### Sender app scaffold

- app.json: name "KBM Remote", slug kbm-remote-sender, SDK 53, automatic
  UI style, newArchEnabled, hermes. NO app/index.js entry file exists.
- Tests: apps/sender/tests/connectionManager.test.ts (real, ws server fake),
  app.test.ts; vitest run. tsconfig.json composite, references protocol/network/
  auth/ui-components, include src/**/*.ts,.tsx + tests.
- Existing files: connectionManager.ts (real), gestureMapper.ts (placeholder),
  secureStore.ts (placeholder), screens/components/index.ts placeholders,
  App.tsx stub.
- Dependencies installed (pnpm): zustand 5, react-navigation/native 7 +
  native-stack 7, gesture-handler ~2.24, safe-area-context 5.4, screens 4.11,
  async-storage 2.1.2, expo-keep-awake ~14.1, expo-haptics ~14.1.

## Plan refinements (from skill)

- Do NOT use expo-router (user wants React Navigation). Entry: index.js +
  App.tsx root. Need GestureHandlerRootView wrapping.
- No emulator available: verify via tsc typecheck + lint + vitest +
  "expo doctor" skip; check Metro bundling via `npx expo export --platform web`
  is NOT possible (not web project) — instead ensure no RN imports break tsc
  by using `@types/react-native`? Expo project uses RN types shipped with RN
  pkg. tsconfig lib ES2022 + no types — check how typecheck passes with RN
  imports: likely needs `types: ["react-native"]` or rely on @types/react-native
  installed by pnpm. Add `@types/react-native` to devDependencies if needed.
- PresentationSlide frame payload shape: check packages/protocol/src/types for
  PresentationSlide — if payload interface exists, use it; else send
  { t, mid:0, v, ts, p: { direction: "next"|"prev" } }? VERIFY before sending.

## Verified wire formats (receiver expects) — use these in sender frame payloads

- MouseMove (0x40): p = { x, y, displayIndex? } (absolute normalized) OR
  { dx, dy } (relative). Click (0x41): { button: "left"|"right"|"middle",
  action: "click"|"dblclick"|"down"|"up" }. Scroll (0x42):
  { axis: "vertical"|"horizontal", amount: number (±15 clamp) }.
  DragStart (0x43): { button } where DragButton = left|right|middle.
  DragMove (0x44): { x, y } ABSOLUTE normalized. DragEnd (0x45): { button }.
- KeyPress (0x50): { keys: string[] } (KeyId strings e.g. "A","ControlLeft","F1",
  "ArrowUp","volumeUp"). KeyHold (0x51): { key: string, repeatStartMs?,
  repeatIntervalMs? }. KeyRelease (0x52): { key: string }. TextInput (0x53):
  { text: string }. Shortcut (0x54): { keys: string[], holdMs? }.
  MediaKey (0x60): { key: "volumeUp"|"volumeDown"|"mute"|"playPause"|"prevTrack"|"nextTrack" }.
  ClipboardSync (0x70): { kind: "text"|"image", data: string } — receiver
  normalizes (text ≤64KB utf8; image base64 PNG ≤8MB). ClipboardQuery (0x71): {}.
  PresentationSlide (0xb0): no payload interface in protocol (registry only) —
  use p: { direction: "next"|"prev" } (not validated by receiver yet; note).
- ClientConnection: connectionState getter; events bridge: stateChange,
  helloAck, authOk, authFailed, message, reconnecting. sendReliable(frame)
  returns FrameResult { ok, ... } (check exact shape if needed; not required).

## Progress log

- [x] Phase 1: deps installed (zustand, nav, async-storage, keep-awake,
      haptics, gesture-handler, safe-area-context, screens).
- [x] theme.ts (M3 tokens lightM3/darkM3 + m3Motion) — DONE.
- [x] store/themeStore.ts (Zustand, AsyncStorage persist, useResolvedTokens,
      hydrateTheme) — DONE.
- [ ] store/connectionStore.ts — Zustand wrapper around ConnectionManager
      singleton (create once), devices list persist AsyncStorage key
      "kbm.devices.v1" { id, name, ip, port }, state from manager events.
- [ ] stores: settingsStore (pointer sensitivity, scroll speed, haptics on),
      clipboardStore (local history of sent texts, max 20),
      presentationStore (slide index, wake lock via useKeepAwake on screen).
- [ ] App.tsx root: NavigationContainer + Stack.Navigator (screens: Home,
      PairDevice, Touchpad, Keyboard, MediaControls, Clipboard,
      PresentationMode, Settings). GestureHandlerRootView wrapper.
- [ ] Shared UI primitives in components/: M3Card, M3Button, M3TextField-ish
      (TextInput wrapper), StatusChip, KeyCap. Use Animated for press scale
      (0.97, 80ms) via Pressable style + Haptics (guard Platform !== web).
- [ ] Screens: Home (devices list, connect/disconnect, status, nav hub),
      PairDevice (IP+port manual entry, saved devices, pairing code entry),
      Settings (theme mode, sensitivity sliders via Pressable +/-),
      Touchpad (PanResponder; tap=click, pan=relative move, edges=scroll zones,
      two-finger not possible in PanResponder → use side-edge drag for scroll),
      Keyboard (rows, shift/caps toggle, symbols page, arrow+modifier cluster,
      TextInput → TextInput frames batched 150ms), Media (big icon buttons),
      Clipboard (history + send + pull query + receiver content display),
      Presentation (next/prev, slide counter, keep awake).
- [ ] Tests: gestureMapper rewrite (pure: pan→frame mapping), theme tests,
      presentation store, keyboard text batching unit tests via vitest.
- [ ] Verify: pnpm -F @kbm-remote/sender typecheck, lint, test. NOTE: tsconfig
      has "types": [] — RN types come via @types/react-native peer? If tsc fails on
      react-native imports, add "@types/react-native": "~0.79.0" (or matching 0.81?)
      to devDependencies. RN 0.79.2 → types package version "0.79" probably.
- [ ] Docs docs/Sender-App-M4.md; commit; zip via apps/sender/../build-zip.sh
      (script exists: /home/ubuntu/kbm-repo/build-zip.sh); copy to
      /mnt/desktop/Remote Emulator/kbm-repo.zip.
