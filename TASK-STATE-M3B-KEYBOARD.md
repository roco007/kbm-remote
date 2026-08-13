# Milestone 3b — Keyboard Subsystem: Task State (internal notes)

## User request

Implement keyboard input: printable keys, function keys, media keys, modifiers, shortcuts,
unicode, long press, key repeat. Platform abstraction layer.

## Protocol facts (verified from packages/protocol/src/types/index.ts)

FrameType: KeyPress 0x50, KeyHold 0x51, KeyRelease 0x52, TextInput 0x53,
Shortcut 0x54, MediaKey 0x60. All fire-and-forget (mid=0) per doc §4.4-4.5.
Note: protocol doc §4.4 says TextInput acknowledged (mid>0) — check actual protocol
types; protocol package has TextInput frame only. Keep implementation aligned with the
code (protocol FrameType enum is the source of truth).

Payload grammar (doc §4.4): KeyPress p={keys: string[]} combo; KeyHold/KeyRelease p={key};
TextInput p={text} up to 4KB; Shortcut p={keys[], holdMs uint16, name}; MediaKey p={key}.

## nut.js 4.2.6 API (verified from typings)

- KeyboardClass: type(...input: StringOrKey), pressKey(...keys: Key[]), releaseKey(...keys: Key[])
- Key enum (105-key US layout): letters A-Z, Num0-9, F1-F24, modifiers LeftControl/LeftSuper/
  LeftWin/LeftCmd/LeftAlt/LeftMeta (and Right*), Shift, Enter, Return, Tab, Space, Backspace,
  Delete, arrows, media: AudioMute/VolDown/VolUp/Play/Stop/Pause/Prev/Next/Rewind/Forward/Repeat/Random
- StringOrKey allows mixed strings + Keys in type() — strings inject text (unicode-ish via type).
- autoDelayMs config between key events.

## Design decisions (final)

1. New module packages/input-provider/src/keyboard.ts:
   - KeyboardProvider interface: press(input), release(input), typeText(input), mediaKey(input)
   - KeyId: union grammar — "a".."z", "A".."Z", "KeyA".."KeyZ" (KeyX grammar from protocol),
     "ControlLeft","ControlRight","ShiftLeft","ShiftRight","AltLeft","AltRight","MetaLeft","MetaRight",
     "F1".."F24", digit/printable names, "Escape","Tab","Backspace","Delete","Enter","Space",
     arrows, "Home","End","PageUp","PageDown","Insert","Pause","PrintScreen","Escape",
     media keys: "volumeUp","volumeDown","mute","playPause","prevTrack","nextTrack".
   - KeyIdResolver: KeyId → nut.js Key enum mapping + printability detection + isModifier,
     isMedia, isPrintable. Unicode text handled via typeText() (nut.js keyboard.type(str)).
2. KeyboardController (packages/input-provider/src/controllers/KeyboardController.ts):
   - pressKeys(combo: KeyId[]) — validate each, delegate press()
   - holdKey/releaseKey — delegate; stateless (OS keeps held), but validate not-held
   - typeText(text) — validate length ≤4KB, non-empty; delegate typeText()
   - shortcut(keys, holdMs) — press combo, wait holdMs (default 120), release;
     injected clock/fakeTimers-friendly sleep fn
   - keyRepeat? Protocol has KeyHold (hold until release) → long press modeled as hold
     with repeat policy: options {repeatStartMs, repeatIntervalMs} — controller doesn't
     generate repeats; OS does on hold. Document. Actually implement optional repeat:
     holdKey(input) fires press then if repeat policy set, schedules repeat pressKey events
     at interval until releaseKey. Simpler & matches "key repeat" requirement.
3. Providers: MockKeyboardProvider (tests), NutJsKeyboardProvider (default — keyboard.type/
   pressKey/releaseKey), NativeKeyboardProvider (per-platform: win SendInput, macOS cliclick
   key, linux xdotool key — reuse native.ts backend pattern).
   NativeKeyboardProvider should reuse the NativeMouseBackend modules? Keyboard needs its
   own backend API (NativeKeyboardBackend) — add to providers/native.ts:
   - press(keyId) / release(keyId) / typeText(text) / media(key) via shell helpers:
     macOS cliclick, linux xdotool, windows powershell SendInput stub.
4. Factory createKeyboardProvider() — nutjs → native → mock (kind:"mock" explicit).
   KeyboardToken in inputModule: keyboardToken.
5. InputService extensions: register handlers KeyPress(0x50), KeyHold(0x51),
   KeyRelease(0x52), TextInput(0x53), Shortcut(0x54), MediaKey(0x60) with
   KEYBOARD_PERMISSION="keyboard" and MEDIA_PERMISSION="media".
   InputModule: createInputService extended with controller+keyboardController, tokens:
   keyboardProviderToken, keyboardControllerToken.
6. Tests: keyboard unit tests (keyId validation/normalization, repeat scheduling with fake
   timers, hold/release state validation, shortcut hold timing, typeText length clamp),
   integration tests in apps/receiver (permission gates 4005, delegation, invalid payloads).
7. Docs: docs/Keyboard-Subsystem-M3b.md; commit; rebuild zip.

## Progress

- [ ] keyboard.ts interfaces + KeyId grammar + validators
- [ ] KeyboardController
- [ ] MockKeyboardProvider + NutJsKeyboardProvider + NativeKeyboardProvider + factory
- [ ] input-provider tests (expect ~20)
- [ ] receiver: keyboardControllerToken/providerToken + InputService handlers + tests (expect ~8)
- [ ] CI green; docs; commit; zip; deliver

## Progress log (Aug 13, 2026)

### Files created (all in packages/input-provider/src/)

- keyboard.ts — KeyId grammar (LetterKey, DigitKey, PrintableKey, ModifierKey,
  FunctionKey, ArrowKey, MediaKey), MEDIA_KEYS, MODIFIER_KEYS, isModifierKey,
  isMediaKey, normalizeKeyId, utf8ByteLength, MAX_TEXT_INPUT_BYTES=4096, inputs
  (Press/Hold/Release/TypeText/MediaKey/Shortcut), KeyboardProvider iface {name,
  press, release, typeText, mediaKey}.
- controllers/KeyboardController.ts — pressKeys (sorts modifiers first via keyOrder),
  holdKey (repeatStartMs/repeatIntervalMs → application-level repeat via setInterval
  armed after sleep(start)), releaseKey, typeText (utf8 clamp + non-empty), mediaKey,
  shortcut (modifiers-first press, sleep DEFAULT_SHORTCUT_HOLD_MS=120, modifiers-last
  release), activeRepeatCount getter. Constants: DEFAULT_REPEAT_START_MS=500,
  DEFAULT_REPEAT_INTERVAL_MS=80, MIN_REPEAT_INTERVAL_MS=30. Options {provider, sleep}.
- providers/keyboardMock.ts — MockKeyboardProvider (spy, failOn map).
- providers/keyboardNutjs.ts — NutJsKeyboardProvider (lazy import @nut-tree-fork/nut-js,
  resolveKeyEnum from nut.Key, toNutKey mapping: Num0-9→Num0..Num9, Space→Space,
  Backquote→Grave, BracketLeft/Right→LeftBracket/RightBracket, Quote→Quote,
  PrintScreen→Print, modifiers→LeftControl/RightControl/LeftShift/RightShift/
  LeftAlt/RightAlt/MetaLeft→LeftWin??LeftSuper/MetaRight→RightWin??RightSuper,
  arrows→Up/Down/Left/Right, media→AudioVolUp/VolDown/Mute/Play/Prev/Next,
  default→keyEnum[keyId]). pressKey/releaseKey keys typed (string|number|object)[].
- providers/keyboardNative.ts — NativeKeyboardBackend iface {name,pressKey(code),
  releaseKey(code),typeText(text),mediaEvent(code)}; LinuxXDotKeyBackend (xdotool
  key/up/type --clearmodifiers), DarwinCliclickKeyBackend (cliclick kd:/ku:/t:/kp:),
  Win32KeyBackend (powershell SendInput with WIN_VK map + clipboard Ctrl+V for
  typeText), X_KEYS/MAC_KEYS/WIN_VK maps, nativeCode fallthrough for letters/digits/
  F-keys; createNativeKeyboardBackend(platform); NativeKeyboardProvider(backend,
  platformKeyMap).
- providers/keyboardFactory.ts — createKeyboardProvider({kind?,platform?}):
  kind:"mock"→MockKeyboardProvider; default/"nutjs"→NutJsKeyboardProvider ("nut.js
  selected; native fallback on first-call failure"); "native"→tryNative or unavailable
  mock; createKeyboardController({...}) convenience.

### Types fixed so far

- InputError in mouse.ts extended with reasons: invalidKey, invalidKeys,
  keyAlreadyHeld, invalidText, textTooLarge, emptyText, invalidMediaKey,
  unsupportedKey, bindingsUnavailable.
- normalizeKeyId: cast to unknown as KeyId for layout/function/arrow matches.
- NutJsKeyboard iface: pressKey/releaseKey (string|number|object)[].

### Remaining typecheck errors (Aug 13 ~03:50)

1. keyboard.ts ~171: `throw new InputError(\`key "${String(value)}"\`...`— value
at that line is after typeof check so it's string, but TS thinks unknown in
template? Actual error at line 171 col 53 =`String(value)`arg? No — it's the`throw new InputError(..., "invalidKey")`call at line 180-183 area... check
current line numbers: error TS2345 at 171:53 "unknown not assignable to string"
— that's`String(value)`in template literal at throw line. And 186:61`MODIFIER_KEYS includes(value) return value`— return string → KeyId needs cast`return value as unknown as KeyId`.
2. keyboardNative.ts line 24: 'ModifierKey' imported but never read — remove from
   import (only MediaKeyInput needed as void marker, or remove the void hack and
   MediaKeyInput import and use input.key in mediaKey impl directly).
3. keyboardNutjs.ts lines 81-86: `return keyEnum.Space` etc. `number|undefined` not
   assignable to `string|number` — add `!` or undefined check per return. Simplest:
   make toNutKey return non-null-checked values via a helper `getEnum(name)` that
   throws unsupportedKey when undefined, call it for all enum lookups.

### Still to do

- Finish typecheck green, run input-provider tests (keyboard.test.ts — write ~20),
- receiver wiring: apps/receiver/src/main/inputModule.ts — add keyboardProviderToken,
  keyboardControllerToken, NutJsKeyboardProvider/NativeKeyboardProvider imports,
  createKeyboardService(container, sessionLookup) → extend InputService with
  keyboard + media handlers (FrameType KeyPress 0x50, KeyHold 0x51, KeyRelease 0x52,
  TextInput 0x53, Shortcut 0x54, MediaKey 0x60). Permissions: KEYBOARD_PERMISSION
  "keyboard", MEDIA_PERMISSION "media".
- InputService extension: registerHandlers for keyboard frames; TextInput/Shortcut
  may be mid>0 reliable per doc — keep fire-and-forget like mouse for now (doc says
  TextInput acknowledged mid>0 — check FrameType registry; simplest: send ctx.send
  Ack? The network layer has Ack frame type; send optional ack for TextInput? Keep
  fire-and-forget but note in docs.)
- Receiver tests ~8: unauth/permission gates (4005), delegation for KeyPress/
  KeyHold/KeyRelease/TextInput/Shortcut/MediaKey, invalid payloads no side effects,
  all frame types registered, DI graph.
- CI green (typecheck/lint/build/test), docs/Keyboard-Subsystem-M3b.md,
  TASK-STATE file update, commit, rebuild zip (cd /home/ubuntu/kbm-repo;
  (git ls-files; git ls-files --others --exclude-standard) > /tmp/repo-files.txt;
  zip -q /home/ubuntu/kbm-remote.zip -@ < /tmp/repo-files.txt),
  cp to /mnt/desktop/Remote Emulator/kbm-repo.zip, deliver.

### M3a precedent (done)

- M3a committed as 8c1b4e2; zip delivery flow verified (2.4MB lean zip works).
- inputModule.ts tokens: monitorToken, providerToken, controllerToken via Container
  from input-provider; ElectronMonitors class; createInputContainer();
  createInputService(container, sessionLookup).
- InputService permission gates close 4005; registerHandlers(router).

## Status (latest)

- input-provider COMPLETE: keyboard.ts, KeyboardController, MockKeyboardProvider,
  NutJsKeyboardProvider, NativeKeyboardProvider (keyboardNative.ts with exported
  X_KEYS/WIN_VK + createNativeKeyboardBackend), keyboardFactory.ts. All typecheck OK.
  Tests packages/input-provider/tests/keyboard.test.ts: 26 passing; all 59 tests in
  input-provider passing (mouse 33 + keyboard 26).
- receiver inputService.ts EXTENDED: keyboard: KeyboardController arg; permissions
  KEYBOARD_PERMISSION="keyboard", MEDIA_PERMISSION="media"; registerHandlers now
  handles 0x50..0x54 + 0x60 (KeyPress/KeyHold/KeyRelease/TextInput/Shortcut/MediaKey);
  checkPermission helper shared. Handlers validate then delegate; keyboard unavailable → warn.
- receiver inputModule.ts WIRED: keyboardProviderToken, keyboardControllerToken;
  createInputContainer registers both; createInputService passes keyboard controller.
- Receiver typecheck OK.

## Next steps (remaining)

1. Extend apps/receiver/tests/inputService.test.ts:
   - register mock KeyboardController (MockKeyboardProvider-based or direct spy controller
     built with {provider: new MockKeyboardProvider(), sleep: async fn}) in container under
     keyboardControllerToken (import keyboardControllerToken from inputModule).
   - Tests: key permission gate (4005 without "keyboard"), media permission separate
     ("media" vs "keyboard"), KeyPress delegates pressKeys modifier-first order,
     KeyHold/KeyRelease round-trip with advanceTimers (use fake timers already),
     TextInput delegates + oversized text rejected no side effects, Shortcut delegates
     (advance timers), MediaKey delegates, invalid key payloads rejected no side effects,
     all 12 frame types registered (extend existing registration test).
2. Full CI: pnpm run typecheck / lint / test / build (all monorepo).
3. Docs: docs/Keyboard-Subsystem-M3b.md (architecture, grammar, controller behaviour,
   repeat design, protocol mapping 0x50-0x54/0x60, providers, DI, tests).
4. Commit git, rebuild lean zip (git ls-files list to /tmp/repo-files.txt, zip -@ ),
   cp to /mnt/desktop/Remote Emulator/kbm-repo.zip, deliver with doc attached.
