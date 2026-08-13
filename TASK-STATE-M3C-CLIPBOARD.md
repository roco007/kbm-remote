# Task State — Milestone 3c: Clipboard Subsystem

## Goal

Clipboard sync in `@kbm-remote/input-provider` + receiver wiring, following the
established pattern (provider contract → platform adapters → factory degrade →
DI tokens in inputModule → permission-gated handlers in InputService).

## Protocol (already declared in packages/protocol/src/types/index.ts)

- ClipboardSync: 0x70
- ClipboardQuery: 0x71
  (no other clipboard frames exist; we use these two, plus the receiver push
  is passive: receiver sends ClipboardSync frames back to sender — same
  FrameRouter/FrameGateway on both directions).

## Repo facts gathered

- `packages/auth` is still a placeholder (no crypto helpers). Transport-level
  TLS only. So for "encryption" we implement a small local
  `packages/input-provider/src/clipboard/crypto.ts` using Node `crypto`:
  AES-256-GCM with per-frame random IV, key derived from the session token
  via HKDF (SHA-256) — document that keys are only as good as the session
  token; TLS already wraps transport.
- Receiver apps/receiver/src/main/inputModule.ts: tokens
  monitorToken/providerToken/controllerToken/keyboardProviderToken/
  keyboardControllerToken, Container from input-provider di.ts.
- InputService: checkPermission(scope) closes 4005; scope constants
  MOUSE_PERMISSION="mouse", KEYBOARD_PERMISSION="keyboard",
  MEDIA_PERMISSION="media". New: CLIPBOARD_PERMISSION="clipboard".
- Factory + providers in packages/input-provider/src/providers/.
- MockMouseProvider / MockKeyboardProvider pattern: record calls.
- Native adapter pattern: keyboardNative.ts has NativeKeyboardBackend +
  execFile shells per platform.

## Design decisions

1. ClipboardProvider contract:
   read(): Promise<ClipboardContent | null> (text or image PNG bytes)
   write(content): Promise<void>
   clear(): Promise<void>
   Content: { kind: "text"|"image", data: string | Buffer, sha256: string }
2. ClipboardController (pure core):
   - sync(content, direction) — validate + bound size (text 64KB, image 8MB)
   - push() — read OS + send
   - apply(content) — conflict resolve: if last-known content differs AND
     receiver owns the clipboard (user edited locally after a sync), REJECT
     (conflict resolution = ownership-based: local edits win; tracked via
     generation counter + hash of last written content).
   - query handling
3. Conflict resolution model:
   - receiver tracks `localGeneration` and `lastKnownHash`.
   - on sync-in: if current OS hash ≠ lastKnownHash → local conflict,
     drop with reason "conflict" (sender notified? frames are fire-and-forget;
     we log + notify via Notification 0xa0 if wired; else warn).
   - on local write (writeLocal): bump generation, record hash.
4. Automatic sync: after keyboard/mouse input activity (receiver writes),
   mark clipboard as locally-owned; on ClipboardSync frame, check ownership.
   Simplest robust: automatic = on every ClipboardSync frame the controller
   applies it (with conflict check); manual = sender initiates upload via
   ClipboardSync and receiver can push its clipboard to sender by
   ClipboardQuery request. We implement a ClipboardPoller (interval) that
   detects OS-side changes and pushes to sender via the gateway (auto push).
   NOTE: sending frames TO sender requires a gateway reference — pass
   FrameGateway/session-sender to ClipboardController (like monitors).
   To keep controller pure-ish: ClipboardController takes {provider, sleep,
   sha256?} and returns an event stream? Simpler: inputModule wires
   ClipboardService (receiver-side service like InputService) with gateway
   reference + poller; controller stays pure.
5. Platform adapters:
   - ClipboardNativeProvider: Linux xclip/xsel (TEXT primary+clipboard),
     macOS pbcopy/pbpaste (+ osascript for PNG via base64), Windows
     powershell Get-Clipboard/Set-Clipboard (-Format Text/Bitmap).
   - MockClipboardProvider for tests.
   - Factory: try native first (availability check via which/can-fail on
     read), else mock unavailable.
6. Encryption: payload in ClipboardSync is {content{kind,data b64}, hmac?}.
   We add a small crypto util: encryptBlob(hexKey, plaintext) → b64
   (aes-256-gcm, 12B IV, 16B tag appended), decryptBlob. Key: session
   token hex; derive via hkdf(info="kbm-clipboard"). Tests use fixed key.
   Note: frame payload is still JSON — encryption is an application-layer
   belt over TLS suspenders; keep it optional via a flag (enabled by
   default).
7. Tests: 25+ in clipboard.test.ts; extend inputService.test.ts with
   clipboard frame tests (permission, conflict, manual/automatic paths).

## Progress

- [x] clipboard.ts (content types, providers, bounds, sha256 helper)
- [ ] ClipboardController
- [ ] Mock + NativeClipboardProvider + factory
- [ ] crypto.ts (AES-256-GCM wrapper)
- [ ] inputModule tokens + container registration
- [ ] InputService handlers 0x70/0x71 + CLIPBOARD_PERMISSION
- [ ] tests + CI green
- [ ] docs/Clipboard-Subsystem-M3c.md, commit, zip, deliver

## Progress update (Phase 2 in progress)

### Done so far (Phase 1 complete, Phase 2 started)

1. `packages/input-provider/src/clipboard.ts` — ClipboardContent {kind,data,sha256},
   ClipboardOwner type, MAX_CLIPBOARD_TEXT_BYTES=64KB, MAX_CLIPBOARD_IMAGE_BYTES=8MB,
   BASE64_RE, base64DecodedLength, utf8ByteLength (imported from keyboard.ts, NOT
   re-declared to avoid barrel clash), sha256Hex, decodeClipboardBlob,
   normalizeClipboardContent (PNG header check 0x89504e47), ClipboardProvider iface
   (read/write/clear), ClipboardOwnership class (markRemoteApplied/markLocalWritten/
   current/canApplyRemote → {allowed,reason: ok|conflict|unchanged}).
2. `packages/input-provider/src/controllers/ClipboardController.ts` — options
   {provider,sleep,cipher,ownership}; lastPushedHash dedup; applyRemoteWrite(raw)
   → decodeInbound → applyContent (dedup check vs lastPushedHash, conflict via
   ownership.canApplyRemote(provider.read sha256), throw InputError clipboardConflict,
   else provider.write + markRemoteApplied); readOutbound/pushOutbound (sets
   lastPushedHash); markLocalClipboardWritten; clear; encryptForTransport (kind
   encrypted + payload b64 when cipher set); decodeInbound handles encrypted kind.
3. `packages/input-provider/src/controllers/clipboardCrypto.ts` — makePayloadCipher
   (sessionToken) → AES-256-GCM, key=sha256(`kbm-clipboard-key:kbm-clipboard-session:${token}`),
   IV 12B random, blob=base64(iv||ct||tag16B). encryptPayload/decryptPayload wrappers.
4. `packages/input-provider/src/providers/clipboardMock.ts` — MockClipboardProvider,
   calls array, seed(content), failOn.
5. `packages/input-provider/src/providers/clipboardNative.ts` — NativeClipboardBackend
   iface; linuxBackend (xclip, -selection clipboard + primary note, encoding buffer
   via `as const`, stdin execFile promise for writeText/writeImage); darwinBackend
   (pbcopy/pbpaste, osascript «class PNGf» for read image, temp PNG file + osascript
   POSIX file for write image); win32Backend (powershell -NoProfile Get/Set-Clipboard,
   image via MemoryStream PNG+Set-Clipboard -Path). createNativeClipboardBackend,
   NativeClipboardProvider class (probeBackend on first use, bindingsUnavailable if
   tooling missing, read tries text then image PNG).
6. `packages/input-provider/src/providers/clipboardFactory.ts` —
   ClipboardProviderKind native|mock|unavailable; createClipboardProvider tries native
   first (probe via constructor), explicit mock/native kinds, degrades to mock
   unavailable.
7. `packages/input-provider/src/index.ts` — added 6 clipboard re-exports.
8. `packages/input-provider/src/mouse.ts` — InputError reasons added: invalidClipboard,
   clipboardTooLarge, invalidBase64, invalidImage, clipboardConflict.
9. BUILD OK for input-provider (after fixing: renamed MAX_CLIPBOARD_TEXT_BYTES/
   MAX_CLIPBOARD_IMAGE_BYTES, removed duplicate utf8ByteLength from clipboard.ts
   (keyboard.ts keeps the only copy), xclip buffer return type, stdin execFile
   patterns, KEY_BYTES const removal).

### Now doing (receiver wiring)

- inputService.ts: DONE — ClipboardController import, CLIPBOARD_PERMISSION, 5th ctor
  arg `clipboard`, registerHandlers adds ClipboardSync 0x70 + ClipboardQuery 0x71,
  hasClipboardPermission helper. STILL NEEDED: handleClipboardSync +
  handleClipboardQuery private methods (add after handleMediaKey ~line 340).
  handleClipboardSync: checkPermission CLIPBOARD_PERMISSION; controller null → warn;
  validate p is object; try controller.applyRemoteWrite(p.payload??p); catch
  clipboardConflict → log warn (no socket close for conflicts — fire-and-forget);
  InputError others → warn; success → log info.
  handleClipboardQuery: sender asks receiver to push clipboard; requires
  CLIPBOARD_PERMISSION; controller.pushOutbound() → if content,
  ctx.send(FrameType.ClipboardSync, await encryptForTransport(...))? Check
  FrameContext API: ctx.send exists? (mouse tests used sent array). Check ctx.send
  signature in network package.
- inputModule.ts: add clipboardProviderToken, clipboardControllerToken;
  createInputContainer registers createClipboardProvider().provider +
  new ClipboardController({provider:...}); createInputService passes clipboard ctrl.
- inputService tests: extend with clipboard describe block (17 tests exist now, 8 mouse
  - 9 keyboard in mouse describe + 9 keyboard block). Add: clipboard permission gate
    4005, auth gate 4005, sync delegates + conflict drops, oversized text rejected
    (90KB), invalid PNG rejected, duplicate no-op, query pushes content (check
    ctx.send(sent) signature first), encryption roundtrip test (makePayloadCipher).
- Docs, commit, zip, deliver.

### Key file locations

- apps/receiver/src/main/inputService.ts (handlers + permissions)
- apps/receiver/src/main/inputModule.ts (DI)
- apps/receiver/tests/inputService.test.ts (integration tests)
- packages/input-provider/tests/ (mouse.test.ts, keyboard.test.ts — mirror for
  clipboard.test.ts)
- apps/receiver vitest command: `pnpm vitest run tests/inputService.test.ts`
- CI: pnpm run typecheck / lint / test / build from repo root
- Zip: cd repo && printf "%s\n" $(git ls-files) | tee /tmp/repo-files.txt &&
  zip -q@ /home/ubuntu/kbm-remote.zip < /tmp/repo-files.txt; cp to
  /mnt/desktop/Remote Emulator/kbm-repo.zip

## State snapshot (after Phase 3 in progress)

### Completed

- Phase 1+2 fully done: clipboard.ts, ClipboardController (with cipher+ownership
  options, applyRemoteWrite/pushOutbound/clear/markLocalClipboardWritten/
  encryptForTransport), clipboardCrypto.ts (makePayloadCipher sha256-based key,
  aes-256-gcm), clipboardMock/native/factory providers, index exports, InputError
  reasons extended, inputService.ts handlers (handleClipboardSync sends Nack
  clipboardConflict via ctx.send; handleClipboardQuery pushes encrypted
  ClipboardSync), inputModule.ts tokens + registrations + service arg.
- 36 clipboard unit tests PASSING in packages/input-provider (95 total there).
- Receiver tests inputService.test.ts extended: clipboard describe block added
  (8 tests: auth gate 4005, permission gate, keyboard-separated gate, apply sync,
  query reply, empty skip, oversized/invalid rejection), registration test now
  includes ClipboardSync+ClipboardQuery (14 types), DI test resolves
  clipboardControllerToken and registers clipboardProviderToken mock.

### Remaining steps

1. Run: cd apps/receiver && pnpm vitest run tests/inputService.test.ts — expect all
   pass (17 mouse+keyboard + 8 clipboard + DI = 27).
2. Full CI: pnpm run typecheck && lint && test && build (repo root).
   NOTE: input-provider dist must be rebuilt after source changes (pnpm -F
   @kbm-remote/input-provider build) before receiver typecheck.
3. Docs: docs/Clipboard-Subsystem-M3c.md (follow pattern of
   docs/Mouse-Subsystem-M3a.md and docs/Keyboard-Subsystem-M3b.md — sections:
   overview, architecture/contracts, validation bounds (64KB text/8MB image, PNG
   header check), conflict resolution algorithm, encryption scheme (AES-256-GCM
   key=sha256(kbm-clipboard-key:kbm-clipboard-session:<token>), IV 12B random,
   blob base64(iv||ct||tag)), platform adapters table (xclip/pbcopy+osascript/
   powershell), factory degrade, protocol frames 0x70/0x71, test matrix, test
   counts).
4. git add/commit (message like "feat(clipboard): add clipboard sync subsystem (M3c)")
   — git config user needed (email: raj.colaco user; previously set
   "Manus Agent <agent@manus.im>" worked?). Push to origin master may fail
   (no GitHub connector) — ignore, note it to user.
5. Zip: (git ls-files; git ls-files --others --exclude-standard | grep -v node_modules)
   pipe into zip -q@ /home/ubuntu/kbm-remote.zip -i@ ; verify size ~2.5MB; copy to
   /mnt/desktop/Remote Emulator/kbm-repo.zip (note mount path has space:
   "/mnt/desktop/Remote Emulator/").
6. message result with attachments zip + docs file.

### Deliverable patterns from prior milestones

- Attachment order: /home/ubuntu/kbm-remote.zip, /home/ubuntu/kbm-repo/docs/<doc>.md
- Mention commit hash, CI numbers (typecheck 12/12 etc.), test counts.
- GitHub connector unavailable → push not possible; offer to enable.
- Next milestone suggestion: 3d media controls (if media handlers are just
  keyboard) — actually media keys done in 3b; suggest 3c-next: remote file
  transfer or presentation mode (Nice-to-haves list) — suggest screen sharing
  or file transfer.

## Final delivery steps (in progress)

- Docs written: docs/Clipboard-Subsystem-M3c.md (done).
- CI FINAL STATE: typecheck green (12/12), lint 0 errors (only pre-existing warnings),
  tests 199 passing (input-provider 95 incl 36 clipboard; receiver 32 incl 8 clipboard),
  build 7/7.
- Next: git commit with message "feat(clipboard): add clipboard sync subsystem (Milestone 3c)",
  git config user "Manus Agent <agent@manus.im>" if unset. Push to origin master will fail
  (no GitHub connector) — mention in result message.
- Zip: (git ls-files; git ls-files --others --exclude-standard | grep -v node_modules |
  grep -v dist) pipe to zip -q@ /home/ubuntu/kbm-remote.zip -i@ ; expect ~2.5MB;
  cp to /mnt/desktop/Remote Emulator/kbm-repo.zip (mount has space in path).
- Result message: attach zip + docs file; mention conflict resolution, encryption scheme,
  platform table, CI numbers, commit hash; suggest Milestone 3d (remote file transfer)
  or presentation mode next.
