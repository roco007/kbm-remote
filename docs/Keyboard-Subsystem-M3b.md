# Milestone 3b — Keyboard Subsystem

**Repository:** `github.com/roco007/kbm-remote` · **Package:** `@kbm-remote/input-provider` · **Author:** Manus AI

This document specifies the keyboard subsystem of the KBM Remote receiver: the key-identifier grammar, the provider-agnostic `KeyboardController`, the platform adapter layer, the receiver-side wiring, and the test strategy. It mirrors the architecture established in Milestone 3a (mouse), so that keyboard and mouse share one input package, one DI composition root, and one permission-gated handler layer on the gateway.

---

## 1. Architecture

The keyboard subsystem reuses the three-layer pipeline proven by the mouse work: a **protocol boundary** that validates and normalizes every untrusted identifier, a **pure controller** that owns all stateful behaviour (combos, holds, repeat timers), and a **provider adapter** that translates normalized identifiers into platform-native calls. Nothing in the controller knows which OS it runs on; nothing in the adapter knows about the protocol.

```
 ┌──────────────────── gateway FrameRouter (inputService) ──────────────────┐
 │  KeyPress 0x50 │ KeyHold 0x51 │ KeyRelease 0x52 │ TextInput 0x53        │
 │  Shortcut 0x54 │ MediaKey 0x60                                         │
 │  └─ permission check ("keyboard" / "media") → KeyboardController ───────│
 └─────────────────────────────────────────────────────────────────────────┘
        │
        ▼
 ┌────────────────── KeyboardController (pure core) ────────────────────────┐
 │  normalizeKeyId → modifier-first combo ordering → hold/repeat timers    │
 │  → UTF-8 length-bounded text → delegated provider calls                 │
 └─────────────────────────────────────────────────────────────────────────┘
        │          KeyboardProvider (contract)
        ▼
 ┌────────────────── platform adapters ─────────────────────────────────────┐
 │  NutJsKeyboardProvider (nut.js 4.x, default)                             │
 │  NativeKeyboardProvider (xdotool / cliclick / PowerShell SendInput)      │
 │  MockKeyboardProvider (tests / unavailable fallback)                     │
 └─────────────────────────────────────────────────────────────────────────┘
```

The same tiny DI container from Milestone 3a composes the graph. Two new tokens were added: `keyboardProviderToken` and `keyboardControllerToken`. The production composition root (`apps/receiver/src/main/inputModule.ts`) now registers the monitors, the mouse provider/controller, the keyboard provider, and the keyboard controller, and hands the keyboard controller to `InputService` as its fourth constructor argument.

| Component           | File                                                            | Role                                                                                                    |
| ------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Key grammar + types | `packages/input-provider/src/keyboard.ts`                       | `KeyId` union, validators (`normalizeKeyId`, `isModifierKey`, `isMediaKey`), input DTOs, UTF-8 boundary |
| Controller          | `packages/input-provider/src/controllers/KeyboardController.ts` | Combos, hold/release, application-level key repeat, Unicode text                                        |
| nut.js adapter      | `packages/input-provider/src/providers/keyboardNutjs.ts`        | `KeyId` → nut.js `Key` enum; text via `keyboard.type`                                                   |
| Native adapter      | `packages/input-provider/src/providers/keyboardNative.ts`       | Per-platform code maps (`WIN_VK`, `X_KEYS`) and a `NativeKeyboardBackend` contract                      |
| Factory             | `packages/input-provider/src/providers/keyboardFactory.ts`      | `createKeyboardProvider()` selection with degrade-to-mock policy                                        |
| Mock                | `packages/input-provider/src/providers/keyboardMock.ts`         | Recording provider for tests                                                                            |
| Receiver bridge     | `apps/receiver/src/main/inputService.ts`                        | Six frame handlers + `KEYBOARD_PERMISSION` / `MEDIA_PERMISSION` gates                                   |
| Composition root    | `apps/receiver/src/main/inputModule.ts`                         | DI tokens, `createInputContainer`, `createInputService`                                                 |

---

## 2. Key Identifier Grammar

The protocol carries keys as plain strings; the receiver must accept them from an untrusted socket and turn them into a closed set before they ever reach a platform adapter. The grammar lives in `keyboard.ts` as the `KeyId` union:

| Family         | Identifiers                                                                                                              | Normalization                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `LetterKey`    | `"A".."Z"` and `"KeyA".."KeyZ"`                                                                                          | lowercase letters promoted to upper; `keyc` → `"KeyC"`          |
| `DigitKey`     | `"0".."9"`                                                                                                               | as-is                                                           |
| `PrintableKey` | `Space`, `Tab`, `Backspace`, `Enter`, `Escape`, punctuation by US layout name (`Backquote`, `Semicolon`, …), numpad keys | as-is                                                           |
| `ModifierKey`  | `ControlLeft/Right`, `ShiftLeft/Right`, `AltLeft/Right`, `MetaLeft/Right`                                                | as-is (left/right sides distinct)                               |
| `FunctionKey`  | `F1`..`F24`                                                                                                              | as-is                                                           |
| `ArrowKey`     | `ArrowUp/Down/Left/Right`                                                                                                | as-is                                                           |
| `MediaKey`     | `volumeUp`, `volumeDown`, `mute`, `playPause`, `prevTrack`, `nextTrack`                                                  | abstract identifiers only — adapter-specific codes are internal |

`normalizeKeyId(value)` accepts a string matching the grammar and returns it narrowed to `KeyId`; anything else (empty string, `null`, non-string, `F25`, `Cmd`, `Ctrl`…) throws `InputError` with reason `invalidKey`. The identifiers were deliberately chosen to map 1:1 onto nut.js's `Key` enum names, which removes most of the translation work for the primary adapter.

---

## 3. KeyboardController Behaviour

The controller validates inputs with `normalizeKeyId` before touching the provider, so every adapter sees only legal identifiers. Time-dependent behaviour (shortcut hold windows, repeat timers) routes through an injected `sleep` so fake-timer tests are deterministic.

### 3.1 pressKeys — atomic combos and shortcuts

`pressKeys({ keys })` accepts one or more keys and dispatches a single provider `press` call after **modifier-first reordering**: modifiers are moved ahead of non-modifiers so that `["KeyV", "ControlLeft"]` is sent as `[ControlLeft, KeyV]`. Empty arrays throw before any provider call. This is the workhorse behind both the `KeyPress` frame and touch-friendly single-key sends.

### 3.2 shortcut — depress, hold, reverse-release

`shortcut({ keys, holdMs })` requires at least two keys, presses the reordered combo, holds for `holdMs` (default 120 ms) via the injected sleep, then releases **modifiers last** (`KeyV` up before `ControlLeft` up). This is what makes `Alt+F4` and `Ctrl+Shift+T` behave like a native keypress rather than a rapid mashing.

### 3.3 hold / release — long press and key repeat

`KeyHold` is a plain hold by default: the controller presses the key and the **OS synthesizes repeats**, matching standard long-press UX (press-and-hold on a phone touchpad scrolls a document at the OS repeat rate).

The sender can opt into **application-level repeat** with `repeatStartMs` (default 500 ms) and `repeatIntervalMs` (default 80 ms, minimum 30 ms). After the start delay the controller re-presses the key on the interval until the matching `KeyRelease` arrives. A held key cannot be held again (`keyAlreadyHeld`), and invalid windows (start ≤ 0 or interval < 30 ms) silently degrade to a plain OS hold. Release is idempotent — releasing a key that was never held is a no-op, never an error.

### 3.4 typeText — full Unicode

`typeText({ text })` flows the entire string to the provider in one call, which is what enables real Unicode (€、世界、😊). Two boundaries are enforced before delegation: empty strings throw, and inputs larger than `MAX_TEXT_INPUT_BYTES = 4096` UTF-8 bytes throw (`textInputTooLarge`) — a 4 KB clipboard paste is allowed; a 4 MB one is not. The boundary counts UTF-8 **bytes**, so a surrogate-pair emoji weighs 4.

### 3.5 mediaKey — abstract media keys

`mediaKey({ key })` accepts only the six `MediaKey` identifiers and delegates to the provider's media path (gated on the `"media"` permission, separate from `"keyboard"` — see §5).

---

## 4. Platform Adapters

### 4.1 NutJsKeyboardProvider (default)

Maps each `KeyId` to the nut.js `Key` enum. Letters, digits, layout keys, function keys, arrows and media keys follow the 1:1 name convention of the grammar; special cases (`Backquote` → `Grave`, `BracketLeft/Right` → `LeftBracket/RightBracket`, `MetaLeft/Right` → `LeftWin/RightWin`, `PrintScreen` → `Print`) are table-driven. `release` inverts the modifier order, and `typeText` uses `keyboard.type(string)`, which injects the full text including Unicode rather than simulating per-character keystrokes. Missing enum entries become `InputError` (`unsupportedKey`) rather than silent failures.

### 4.2 NativeKeyboardProvider (fallback)

A `NativeKeyboardBackend` contract (`pressKey`, `releaseKey`, `typeText`, `mediaKey`) backs three reference implementations: **Linux** shells out to `xdotool key` / `xdotool type --clearmodifiers` / `xdotool key --clearmodifiers XF86Audio*`, **macOS** to `cliclick kp:/kd:/ku:`, and **Windows** to PowerShell `Add-Type` wrappers over `SendInput` with VK codes from the exported `WIN_VK` table. All three run asynchronously via `execFile`, never blocking the event loop. Code maps are exported (`X_KEYS`, `WIN_VK`) so the adapter tables themselves are unit-testable without an input device.

### 4.3 Selection policy

`createKeyboardProvider()` follows the same degrade-as-you-go policy as the mouse factory: nut.js is tried first, the native backend second, and a `MockKeyboardProvider` tagged `kind: "unavailable"` is returned as a last resort so the receiver always starts and can display a clear status message. `kind: "mock"` or `kind: "native"` can be forced for tests or CLI use.

---

## 5. Receiver Wiring and Security

`InputService` gained six handlers (`KeyPress` 0x50, `KeyHold` 0x51, `KeyRelease` 0x52, `TextInput` 0x53, `Shortcut` 0x54, `MediaKey` 0x60), three permission scopes (`KEYBOARD_PERMISSION = "keyboard"`, `MEDIA_PERMISSION = "media"`, alongside `MOUSE_PERMISSION`), and a shared `checkPermission` gate that closes offending sockets with 4005. The design decisions echo the mouse subsystem:

1. **Fire-and-forget.** Handlers never reply; input frames keep `mid === 0` and go through the controller synchronously (releases happen in a detached `void` promise) to keep latency minimal.
2. **Boundary validation first.** Structural checks (`keys` must be a non-empty array, `key`/`text` must be the right type, media key must be in the set) run before delegation, so malformed payloads produce warnings and zero OS side effects.
3. **Controller as failure boundary.** If the keyboard controller is unavailable (no adapter could be created), keyboard frames are logged and dropped — the receiver never crashes, and mouse input keeps working.
4. **Media is a separate scope.** A sender with only `"keyboard"` cannot fire `volumeUp`; media permissions are granted independently in the trusted-device configuration.

---

## 6. Test Strategy

The keyboard suite adds **26 tests** to `packages/input-provider/tests/keyboard.test.ts`, bringing the input package to **59 passing tests** overall. Coverage goals:

| Area           | Tests                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Grammar        | letter/digit/function/printable/modifier/media acceptance, case normalization, rejection of `Cmd`/`F25`/empty/non-string               |
| Predicates     | `isModifierKey` and `isMediaKey` narrowing                                                                                             |
| UTF-8 boundary | ASCII, 3-byte (`€`, `日`), 4-byte surrogate pairs (😊)                                                                                 |
| pressKeys      | modifier-first reordering, empty-array rejection, invalid-key rejection with no provider side effects                                  |
| shortcut       | press–hold–reverse-release order, single-key rejection, injected sleep honoured                                                        |
| hold/repeat    | plain OS hold, application-level repeat fires after start delay, double-hold rejection, invalid-window degradation, idempotent release |
| text/media     | unicode delegation, 4 KB byte boundary, empty text, media delegation and rejection                                                     |
| Factory        | nutjs default, explicit mock, unknown-kind fallback                                                                                    |
| Native tables  | every modifier + media key present in `WIN_VK` and `X_KEYS`                                                                            |

Receiver integration tests (`apps/receiver/tests/inputService.test.ts`) grew from 8 to **17 tests** with a dedicated `"InputService — keyboard subsystem"` block: unauthenticated close 4005, keyboard and media permission gates (verified as _separate_ scopes), KeyPress modifier reordering across the wire, the hold→repeat→release round trip against fake timers, text input with Unicode plus oversized-rejection, shortcut hold windows, media delegation, and invalid-payload rejection with zero provider calls. A router-registration test asserts all twelve mouse + keyboard frame types are wired. Full CI (typecheck 12/12 packages, lint 0 errors, all test suites, build 7/7) is green.

---

## 7. Open Items and Next Milestones

The grammar currently covers the US physical layout; localized layouts (e.g. `KeyA` on an AZERTY keyboard) map to the physical key, not the produced character — senders that want the _character_ "a" on AZERTY should use `TextInput` instead of `KeyPress`, which is by design. `native` adapter shells are reference implementations awaiting optional native addon bindings for production hardening. The clipboard frames (0x70–0x71) and file transfer (0x80) declared in the protocol enum are the natural next milestones, and the permission/token/handler pattern established here extends to them without structural change.
