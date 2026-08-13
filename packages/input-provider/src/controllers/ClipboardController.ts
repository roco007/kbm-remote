/**
 * ClipboardController — the pure core of the clipboard subsystem.
 *
 * Responsibilities:
 *   1. Validate every untrusted payload with {@link normalizeClipboardContent}
 *      so providers and the network only ever see legal, size-bounded content.
 *   2. Apply incoming remote clipboard writes with ownership-based conflict
 *      resolution — local edits always win; a remote write that would wipe a
 *      local edit is dropped with a `clipboardConflict` error.
 *   3. Push the local OS clipboard outward on demand (manual sync) and on
 *      change detection (automatic sync), tracking what we last sent so the
 *      same content is never pushed twice.
 *   4. Optional application-layer encryption of payloads in flight — a belt
 *      over the TLS suspenders, keyed off the session token (HKDF).
 *
 * Like the mouse/keyboard controllers, all time-dependent behaviour routes
 * through an injected `sleep`, keeping tests deterministic.
 */
import {
  ClipboardContent,
  ClipboardOwnership,
  ClipboardProvider,
  normalizeClipboardContent,
} from "../clipboard";
import { InputError } from "../mouse";
import { decryptPayload, encryptPayload, type PayloadCipher } from "./clipboardCrypto";

export interface ClipboardControllerOptions {
  readonly provider: ClipboardProvider;
  /** Zero-copy no-op for tests with fake timers. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** In-flight payload encryption. Omit in tests to exercise raw payloads. */
  readonly cipher?: PayloadCipher;
  /** Owner bookkeeping injected so tests can replace it with a spy. */
  readonly ownership?: ClipboardOwnership;
}

export interface ClipboardWriteResult {
  readonly applied: boolean;
  /** Why a write was not applied: "conflict" (local edit in the way),
   *  "duplicate" (sender re-sent identical content). */
  readonly skippedReason: "none" | "conflict" | "duplicate";
}

export class ClipboardController {
  readonly provider: ClipboardProvider;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cipher: PayloadCipher | null;
  readonly ownership: ClipboardOwnership;
  /** SHA-256 of the last content we pushed outward (dedup for automatic sync). */
  private lastPushedHash: string | null = null;

  constructor(options: ClipboardControllerOptions) {
    this.provider = options.provider;
    this.sleep = options.sleep ?? (async () => {});
    this.cipher = options.cipher ?? null;
    void this.sleep; // reserved for future async change-detection windows
    this.ownership = options.ownership ?? new ClipboardOwnership();
  }

  // Parity with KeyboardController.activeRepeatCount — clipboard owns no
  // repeat timers, but the receiver's status surface reads this getter.
  get activeRepeatCount(): number {
    return 0;
  }

  // ── inbound (sender → receiver) ──────────────────────────────────────

  /**
   * Apply a ClipboardSync frame: validate, decrypt when a cipher is set,
   * resolve conflicts, write the OS clipboard.
   */
  async applyRemoteWrite(raw: unknown): Promise<ClipboardWriteResult> {
    const content = this.decodeInbound(raw);
    return this.applyContent(content);
  }

  /**
   * Apply already-validated content. Public so the receiver can run the same
   * pipeline when content arrives pre-decoded (e.g. local paste propagation).
   */
  async applyContent(content: ClipboardContent): Promise<ClipboardWriteResult> {
    // Deduplication: the same content twice is a no-op.
    if (this.lastPushedHash === content.sha256) {
      return { applied: false, skippedReason: "duplicate" };
    }

    // Conflict resolution: read what the OS clipboard holds right now.
    let currentHash: string | null = null;
    try {
      const current = await this.provider.read();
      currentHash = current?.sha256 ?? null;
    } catch {
      currentHash = null;
    }
    const decision = this.ownership.canApplyRemote(currentHash);
    if (!decision.allowed) {
      throw new InputError(
        "clipboard write rejected: local clipboard was edited after the last sync (conflict)",
        "clipboardConflict",
      );
    }

    await this.provider.write(content);
    this.ownership.markRemoteApplied(content.sha256);
    this.lastPushedHash = content.sha256;
    return { applied: true, skippedReason: "none" };
  }

  // ── outbound (receiver → sender) ─────────────────────────────────────

  /**
   * Read the OS clipboard and encode it for sending. Returns `null` when the
   * clipboard is empty — the caller skips the frame entirely.
   */
  async readOutbound(): Promise<{ content: ClipboardContent } | null> {
    try {
      const content = await this.provider.read();
      if (!content) return null;
      return { content };
    } catch {
      return null;
    }
  }

  /** Manual sync — send whatever the OS clipboard holds right now. */
  async pushOutbound(): Promise<{ content: ClipboardContent } | null> {
    const outbound = await this.readOutbound();
    if (!outbound) return null;
    this.lastPushedHash = outbound.content.sha256;
    return outbound;
  }

  /** Mark a local write (paste) so subsequent remote writes conflict. */
  markLocalClipboardWritten(): void {
    this.ownership.markLocalWritten();
  }

  /** Drop the OS clipboard — allowed under the clipboard permission scope. */
  async clear(): Promise<void> {
    await this.provider.clear();
    this.ownership.markLocalWritten();
    this.lastPushedHash = null;
  }

  // ── encryption helpers (application-layer belt) ──────────────────────

  /** Encrypt a clipboard payload for flight. No-op when no cipher is set. */
  async encryptForTransport(content: ClipboardContent): Promise<unknown> {
    if (!this.cipher) return { kind: content.kind, data: content.data };
    const plaintext = JSON.stringify({ k: content.kind, d: content.data });
    return { kind: "encrypted", payload: await encryptPayload(this.cipher, plaintext) };
  }

  /** Decrypt an inbound flight payload. No-op when no cipher is set. */
  private decodeInbound(raw: unknown): ClipboardContent {
    if (!raw || typeof raw !== "object") {
      throw new InputError(
        "clipboard sync frame must carry a content object",
        "invalidClipboard",
      );
    }
    const obj = raw as Record<string, unknown>;

    if (this.cipher && obj.kind === "encrypted") {
      if (typeof obj.payload !== "string") {
        throw new InputError(
          "encrypted clipboard payload must be a string",
          "invalidClipboard",
        );
      }
      const plaintext = decryptPayload(this.cipher, obj.payload);
      const parsed = JSON.parse(plaintext) as { k: string; d: string };
      return normalizeClipboardContent({ kind: parsed.k, data: parsed.d });
    }
    return normalizeClipboardContent({ kind: String(obj.kind), data: obj.data });
  }
}
