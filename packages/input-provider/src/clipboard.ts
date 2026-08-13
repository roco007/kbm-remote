/**
 * clipboard.ts — the contract and boundary rules of the clipboard subsystem.
 *
 * One file, dependency-free (only Node's `crypto` for hashing/encoding):
 *
 *   1. {@link ClipboardContent} — the single shape that travels over the wire
 *      and into every provider: text or a PNG image.
 *   2. {@link ClipboardProvider} — the platform abstraction: `read` / `write`
 *      / `clear` against the OS clipboard, never anything else.
 *   3. Validation + bounds — size ceilings enforced *before* any provider
 *      call or network send, so a misbehaving (or malicious) sender can
 *      never fill the receiver's memory or clipboard.
 *   4. Ownership bookkeeping — a `ClipboardOwner` helper that records which
 *      side last wrote the clipboard so local edits always win conflicts.
 */
import { createHash } from "node:crypto";

import { utf8ByteLength } from "./keyboard";
import { InputError } from "./mouse";

/** Clipboard content kinds accepted by the protocol. */
export type ClipboardKind = "text" | "image";

/** A validated clipboard payload — never constructed from raw input. */
export interface ClipboardContent {
  readonly kind: ClipboardKind;
  /** UTF-8 string for text; base64-encoded PNG for images. */
  readonly data: string;
  /** Lowercase hex SHA-256 of the decoded bytes — used for change detection. */
  readonly sha256: string;
}

/** Human-readable ownership of the clipboard at any moment. */
export type ClipboardOwner = "remote" | "local" | "unknown";

// ── boundary constants ───────────────────────────────────────────────────

/** Max UTF-8 bytes of a synced text payload (generous paste buffer, no file). */
export const MAX_CLIPBOARD_TEXT_BYTES = 64 * 1024; // 64 KB

/** Max base64 bytes of a synced image payload (~6 MB of PNG). */
export const MAX_CLIPBOARD_IMAGE_BYTES = 8 * 1024 * 1024;

// ── validation ───────────────────────────────────────────────────────────

/**
 * Raw base64 validation — rejects anything that isn't standard base64 with
 * optional padding, which makes every decoded byte predictable.
 */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Number of bytes a base64 string decodes to (exact, padding-aware). */
export function base64DecodedLength(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** Lowercase hex SHA-256 of arbitrary bytes. */
export function sha256Hex(bytes: Buffer | string): string {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Decode a base64 payload with a byte ceiling. Throws `InputError`
 * (`clipboardTooLarge` / `invalidBase64`) instead of silently truncating.
 */
export function decodeClipboardBlob(b64: string, maxBytes: number): Buffer {
  if (!BASE64_RE.test(b64)) {
    throw new InputError("clipboard payload is not valid base64", "invalidBase64");
  }
  const len = base64DecodedLength(b64);
  if (len > maxBytes) {
    throw new InputError(
      `clipboard payload exceeds ${maxBytes} byte limit (${len} bytes)`,
      "clipboardTooLarge",
    );
  }
  return Buffer.from(b64, "base64");
}

/**
 * Normalize untrusted clipboard input into a {@link ClipboardContent}.
 * Text is stored verbatim (re-validated on decode); images must decode to
 * a PNG header (`89 50 4E 47`), which kills most bogus payloads cheaply.
 */
export function normalizeClipboardContent(input: {
  kind?: unknown;
  data?: unknown;
}): ClipboardContent {
  if (!input || typeof input !== "object") {
    throw new InputError("clipboard content must be an object", "invalidClipboard");
  }
  const kind = input.kind;
  if (kind !== "text" && kind !== "image") {
    throw new InputError(
      `clipboard content kind must be "text" or "image" (got ${String(kind)})`,
      "invalidClipboard",
    );
  }
  const data = input.data;
  if (typeof data !== "string") {
    throw new InputError("clipboard content data must be a string", "invalidClipboard");
  }

  if (kind === "text") {
    if (utf8ByteLength(data) > MAX_CLIPBOARD_TEXT_BYTES) {
      throw new InputError(
        `text payload exceeds ${MAX_CLIPBOARD_TEXT_BYTES} byte limit`,
        "clipboardTooLarge",
      );
    }
    return { kind, data, sha256: sha256Hex(Buffer.from(data, "utf8")) };
  }

  const decoded = decodeClipboardBlob(data, MAX_CLIPBOARD_IMAGE_BYTES);
  if (
    decoded.length < 4 ||
    decoded[0] !== 0x89 ||
    decoded[1] !== 0x50 ||
    decoded[2] !== 0x4e ||
    decoded[3] !== 0x47
  ) {
    throw new InputError("image payload must be a valid PNG", "invalidImage");
  }
  return { kind, data, sha256: sha256Hex(decoded) };
}

// ── provider contract ────────────────────────────────────────────────────

/**
 * Platform abstraction for the OS clipboard. Implementations must be
 * idempotent where possible and never throw for benign states (an empty
 * clipboard reads as `null`, never an error).
 */
export interface ClipboardProvider {
  readonly name: string;
  /** Read the OS clipboard; `null` when empty or unreadable. */
  read(): Promise<ClipboardContent | null>;
  /** Write content to the OS clipboard. */
  write(content: ClipboardContent): Promise<void>;
  /** Clear the OS clipboard. */
  clear(): Promise<void>;
}

// ── ownership / conflict bookkeeping ─────────────────────────────────────

/**
 * Tracks which side last wrote the clipboard so conflicts resolve in favour
 * of local edits — the same rule desktop-clipboard-sync tools (KDE Connect,
 * Mouse Without Borders) use, because silently overwriting what the user
 * just typed locally is the worst failure mode.
 *
 * Rules:
 *   1. The side that last *wrote* the clipboard owns it.
 *   2. An incoming remote write is applied only while we own the clipboard
 *      or it has never been observed (`unknown`).
 *   3. If the OS clipboard changed underneath us (local edit) after a sync,
 *      the incoming write is dropped with reason `conflict`.
 */
export class ClipboardOwnership {
  /** SHA-256 of the last content we applied or wrote. */
  private lastKnownHash: string | null = null;
  /** Who last wrote: "remote" after applying a sync frame, "local" after a
   *  local write/clear, "unknown" at startup. */
  private owner: ClipboardOwner = "unknown";

  /** Called when a remote ClipboardSync frame is applied locally. */
  markRemoteApplied(hash: string): void {
    this.lastKnownHash = hash;
    this.owner = "remote";
  }

  /**
   * Called when the receiver writes or clears its own clipboard.
   * `restoredHash` records what the OS clipboard now holds after a local
   * edit — when it matches a previously synced hash the user has restored
   * the remote content and incoming syncs are re-allowed. Omit it for an
   * untracked local edit, which stays strictly local until cleared.
   */
  markLocalWritten(restoredHash?: string | null): void {
    this.owner = "local";
    this.lastKnownHash = restoredHash ?? null;
  }

  readonly current = (): ClipboardOwner => this.owner;

  /**
   * Decide whether an incoming remote write may be applied.
   * `currentOsHash` is the hash of what the OS clipboard holds right now.
   */
  canApplyRemote(currentOsHash: string | null): {
    allowed: boolean;
    reason: "ok" | "conflict" | "unchanged";
  } {
    if (this.owner === "local") {
      // Local side edited after the last sync → incoming write would wipe a
      // local edit. Only allow it if the clipboard is unchanged since we
      // gave up ownership (i.e. the user put back exactly what we synced).
      if (this.lastKnownHash && this.lastKnownHash === currentOsHash) {
        return { allowed: true, reason: "ok" };
      }
      return { allowed: false, reason: "conflict" };
    }
    if (currentOsHash && currentOsHash === this.lastKnownHash) {
      return { allowed: true, reason: "unchanged" };
    }
    return { allowed: true, reason: "ok" };
  }
}
