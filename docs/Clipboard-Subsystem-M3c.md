# Milestone 3c — Clipboard Synchronization Subsystem

**Author:** Manus AI · **Status:** Implemented and CI-verified · **Companion docs:** [Protocol Documentation](./Protocol-Documentation.md), [Mouse Subsystem M3a](./Mouse-Subsystem-M3a.md), [Keyboard Subsystem M3b](./Keyboard-Subsystem-M3b.md)

## 1. Overview and Scope

The clipboard subsystem is the receiver-side implementation of Milestone 3c: it synchronizes clipboard content between the sender and the receiver across the secure WebSocket channel. It covers plain text and PNG images, both **automatic sync** (the sender's clipboard observer pushes a `ClipboardSync` frame whenever the sender's clipboard changes) and **manual sync** (the user taps "send clipboard" or "grab clipboard" on the sender, mapping to `ClipboardSync` and `ClipboardQuery` frames respectively), **conflict resolution** in which a local edit on the receiver always wins over an incoming remote write, and **application-layer encryption** of clipboard payloads keyed off the shared session token — a belt over the TLS suspenders.

The subsystem reuses every pattern established in Milestones 3a and 3b: a provider-agnostic core in `packages/input-provider`, thin per-platform adapters behind a single `ClipboardProvider` contract, a composition root with typed dependency injection in `apps/receiver`, and permission gating through the same session-scope mechanism. All 36 input-provider clipboard tests and 8 receiver clipboard integration tests pass, and the full monorepo CI is green across all 12 projects (typecheck 12/12, lint 0 errors, test 199 passing, build 7/7).

## 2. Architecture

```
Sender                                 Receiver
┌──────────────────┐           ┌─────────────────────────────────────────┐
│ clipboard change │ 0x70      │  InputService                           │
│ observer         ├──────────▶│   handleClipboardSync                   │
│ (auto)           │ Sync      │   ┌─────────────────────────────────┐   │
│                  │           │   │  ClipboardController (pure core)│   │
│ "grab clipboard" │ 0x71      │   │  validate → decrypt → dedup →   │   │
│ (manual)         ├──────────▶│   │  conflict check → provider.write│   │
│   ▲              │ Sync      │   └──────────────┬──────────────────┘   │
│   │  receiver    │ (reply)   │                  │ read                 │
│   └──────────────┘           │   ClipboardProvider (adapter)          │
│                              │   ┌─────────┬─────────┬────────┐       │
│                              │   │xclip    │pbcopy+  │powershell│      │
│                              │   │(Linux)  │osascript│(Win32) │       │
│                              │   │         │(macOS)  │        │       │
│                              │   └─────────┴─────────┴────────┘       │
└──────────────────┘           └─────────────────────────────────────────┘
```

The two frame types carry meaning in opposite directions. `ClipboardSync` (0x70) is fire-and-forget in the sender-to-receiver direction: a conflict on the receiver produces a `Nack` with the machine-readable reason `clipboardConflict` so the sender can show a single notice, but the connection is never closed for it. `ClipboardQuery` (0x71) is the manual pull: the receiver reads its own OS clipboard and replies with a `ClipboardSync` frame containing the content (encrypted when a cipher is configured), skipping the reply entirely when the clipboard is empty.

### 2.1 The contracts

```typescript
// packages/input-provider/src/clipboard.ts
interface ClipboardProvider {
  readonly name: string;
  read(): Promise<ClipboardContent | null>;   // null = empty / unreadable
  write(content: ClipboardContent): Promise<void>;
  clear(): Promise<void>;
}

interface ClipboardContent {
  readonly kind: "text" | "image";
  readonly data: string;                      // UTF-8 text, or base64 PNG
  readonly sha256: string;                    // lowercase hex — change detection
}
```

A `ClipboardContent` is never constructed directly from untrusted input; it can only come out of `normalizeClipboardContent`, which is the single validation choke point for the whole subsystem.

## 3. Validation and Boundaries

Every inbound payload passes through `normalizeClipboardContent` before it touches the OS clipboard. The rules are deliberately tight: the `kind` must be exactly `"text"` or `"image"`; text is bounded to **64 KB of UTF-8** (a generous paste buffer — clipboard sync is not a file-transfer channel); images are bounded to **8 MB of base64** (roughly 6 MB of decoded PNG) and are required to decode to a **PNG magic header** (`89 50 4E 47`), which cheaply kills most bogus payloads. Base64 decoding itself is length-checked before allocation and never silently truncates — anything over the ceiling throws `clipboardTooLarge` with a machine-readable reason, and malformed encodings throw `invalidBase64`.

| Boundary | Limit | Enforcement |
|---|---|---|
| Text payload | 64 KB UTF-8 | `utf8ByteLength` (accounts for 4-byte codepoints) |
| Image payload | 8 MB base64 | `base64DecodedLength` before decode |
| Image format | PNG only | magic-byte check after decode |
| Encoding | standard base64, padding-aware | `/^[A-Za-z0-9+/]*={0,2}$/` |
| Identity | SHA-256 over decoded bytes | used for dedup and conflict detection |

## 4. Conflict Resolution

Clipboard sync is the one subsystem in the project where the sender and receiver can both legitimately change the same resource at the same time, so the controller tracks **ownership** through a dedicated `ClipboardOwnership` bookkeeper. The model is deliberately conservative: **local edits always win**, and an incoming remote write is never applied when it would wipe something the user changed locally.

The owner machine has three states — `remote` (the last change came from the sender), `local` (the user edited the receiver clipboard after a sync), and `unknown` (initial state). Each incoming write consults `canApplyRemote(currentOsHash)`, which returns a decision rather than mutating anything:

| Current OS hash vs. bookkeeping | Decision |
|---|---|
| equals the last synced remote hash | `unchanged` — the sender re-sent identical content; no-op |
| equals the hash we last wrote remotely | allowed — the OS still holds our write; safe to re-apply (idempotent paste) |
| anything else, with known remote ownership | `conflict` — the user edited locally; the remote write is dropped |
| `unknown` ownership | allowed — first sync always applies |

When a write is applied, the owner flips to `remote` and records the hash. A local edit flips it to `local`; the user can transparently **restore** the previously synced content by putting the identical bytes back, which the bookkeeper detects through the `restoredHash` parameter and re-allows remote writes for. `ClipboardSync` duplicates are also short-circuited before any provider call via a `lastPushedHash` dedup flag, so a flaky connection that re-sends the same paste twice produces exactly one OS write.

In the receiver handler, a conflict never crashes the connection: it is logged, a `Nack(clipboardConflict)` is emitted for the sender's UI, and execution stops with zero clipboard side effects.

## 5. Encryption in Transit

The channel is already TLS (WSS, Milestone 2), but clipboard content is precisely the kind of payload that warrants per-payload confidentiality — a TLS terminator, a proxy that logs frames, or a relay that fans out to other sessions must not see it. `clipboardCrypto.ts` therefore implements an optional application-layer envelope on top of the TLS channel:

```
scheme: AES-256-GCM
key:  SHA-256("kbm-clipboard-key:kbm-clipboard-session:<sessionToken>") — 32 bytes
iv:   12 fresh random bytes per encryption (never reused)
blob: base64(iv ‖ ciphertext ‖ 16-byte GCM tag)
```

The session token is the high-entropy 256-bit secret established during pairing (Milestone 1), so anyone holding it can decrypt — which is exactly the intended threat model: confidentiality against everything except a fully authenticated session. `makePayloadCipher` returns `null` for empty tokens and refuses blobs shorter than IV + ciphertext + tag. The controller's `encryptForTransport` wraps content as `{ kind: "encrypted", payload }`; inbound, `decodeInbound` decrypts and parses the compact JSON `{ k, d }` before passing it through the same validation choke point, so an encrypted payload enjoys exactly the same boundary checks as a raw one. Tampering with a single bit anywhere in the blob makes the GCM tag verification fail and the frame is dropped with zero clipboard side effects — covered by the test suite's byte-flip case.

## 6. Platform Adapters

There is no cross-platform clipboard library in the dependency tree; the adapter shells out to tooling present on every desktop OS, which keeps the receiver free of native addons that break on Electron upgrades.

| Platform | Tooling | Text | Image |
|---|---|---|---|
| Linux (X11) | `xclip` | `-selection clipboard -o/-i` (stdin) | `-t image/png` round-trip |
| macOS | `pbcopy` / `pbpaste` / `osascript` | stdin/text via pbcopy/pbpaste | `«class PNGf»` via osascript; write uses a temp PNG + `POSIX file` import |
| Windows | `powershell.exe -NoProfile` | `Get/Set-Clipboard` | `MemoryStream` PNG encode + `Set-Clipboard -Path` |

A `NativeClipboardBackend` contract keeps the three implementations behind one adapter surface. Two practical details are worth noting. On Linux, the **primary selection** (middle-click paste) is read as a fallback when the clipboard itself is empty, because remote-control users routinely expect middle-paste content to be visible; image writes pipe base64 through stdin with a 5-second timeout rather than blocking. On Windows, every PowerShell call spawns a fresh `-NoProfile` host (~150 ms per operation), which is acceptable for manual sync and change polling but not for hot loops; single quotes in pasted text are escaped per PowerShell's own rules. The provider **probes lazily** on first use — `xclip` can be missing on minimal X11 installs — and a failed probe throws `bindingsUnavailable` rather than crashing the receiver.

The factory policy mirrors the mouse/keyboard factories: native is attempted first (with the overrideable platform for tests), explicit `mock`/`native` kinds are honored, and any failure degrades to a mock provider tagged `"unavailable"` so the receiver always starts.

## 7. Receiver Wiring

`InputModule` adds two tokens (`clipboardProviderToken`, `clipboardControllerToken`) and registers the factory-selected provider and the controller as singletons, exactly as for mouse and keyboard. `InputService` registers the two clipboard frame handlers behind `CLIPBOARD_PERMISSION`, a permission scope **separate** from `keyboard` and `media` — the integration tests verify a keyboard-only session is closed with 4005 on a clipboard frame, keeping the permission model additive. Inbound validation errors are logged and dropped without OS side effects; the handler chain is fire-and-forget so clipboard frames never pay for latency monitoring overhead.

## 8. Test Matrix

The input-provider suite (36 tests) covers validation boundaries including the exact 64 KB limit and one-byte-over rejection, base64 and PNG rejection, stable SHA-256 digests, the full ownership state machine (unknown → remote → conflict → restore → ok, plus `unchanged` dedup), controller apply/dedup/conflict/outbound semantics with a spy provider, and the encryption round-trip including byte-flip tampering and cross-token decryption failure. The receiver suite (8 tests) covers the auth gate (4005), the clipboard permission gate, separation from keyboard/media scopes, remote apply delegation, the query reply round-trip (encrypted envelope round-tripping through `encryptForTransport`/`decodeInbound`), empty-clipboard skip, and oversized/invalid payload rejection. The DI test confirms the full graph — monitors, mouse, keyboard, and clipboard — resolves from one container.

## 9. Deliverables and Verification

All new code is in `packages/input-provider/src/clipboard.ts`, `packages/input-provider/src/controllers/ClipboardController.ts`, `packages/input-provider/src/controllers/clipboardCrypto.ts`, and `packages/input-provider/src/providers/clipboard{Mock,Native,Factory}.ts`, with receiver wiring in `apps/receiver/src/main/{inputModule,inputService}.ts` and tests in `packages/input-provider/tests/clipboard.test.ts` and `apps/receiver/tests/inputService.test.ts`. The commit lands on `master` (local — the GitHub push requires the GitHub connector, as before). Full CI: typecheck 12/12 projects green, lint 0 errors, 199 tests passing across all suites (auth 1, ui-components 2, protocol 15, network 46, input-provider 95, sender 8, receiver 32), build 7/7.

## 10. Open Points and Next Steps

Two conscious scope decisions are documented rather than hidden. **Wayland** clipboard access needs `wl-copy`/`wl-paste` paths in addition to `xclip` — the Linux adapter documents this and the factory degrades cleanly in the meantime. **Clipboard history** (the "nice to have") is not implemented; the dedup hash and ownership model are the foundation it will build on. The natural continuation is Milestone 3d (remote file transfer, using the same validated, encrypted, size-bounded payload machinery with its own permission scope) or presentation mode — both reuse the validated envelope pattern this milestone established.
