/**
 * Clipboard subsystem tests — grammar/validation, controller behaviour,
 * conflict resolution, encryption round-trips, providers, and factory
 * selection.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_CLIPBOARD_IMAGE_BYTES,
  MAX_CLIPBOARD_TEXT_BYTES,
  ClipboardOwnership,
  InputError,
  base64DecodedLength,
  decodeClipboardBlob,
  normalizeClipboardContent,
} from "../src";
import { ClipboardController } from "../src/controllers/ClipboardController";
import { makePayloadCipher } from "../src/controllers/clipboardCrypto";
import { createClipboardProvider } from "../src/providers/clipboardFactory";
import { MockClipboardProvider } from "../src/providers/clipboardMock";
import { createNativeClipboardBackend } from "../src/providers/clipboardNative";

// ── validation & boundaries ──────────────────────────────────────────────

describe("clipboard validation — boundaries", () => {
  it("accepts text at exactly the 64 KB byte limit", () => {
    // 16 KB of a 4-byte emoji = exactly 65 536 UTF-8 bytes.
    const text = "😊".repeat(16 * 1024);
    expect(() => normalizeClipboardContent({ kind: "text", data: text })).not.toThrow();
  });

  it("rejects text one byte over the limit", () => {
    const text = "x".repeat(MAX_CLIPBOARD_TEXT_BYTES + 1);
    expect(() => normalizeClipboardContent({ kind: "text", data: text })).toThrow(
      InputError,
    );
  });

  it("rejects oversized image blobs with a machine-readable reason", () => {
    const big = Buffer.alloc(MAX_CLIPBOARD_IMAGE_BYTES + 1, 0x89).toString("base64");
    // Must fail with clipboardTooLarge before any PNG header check path quirk.
    expect(() => normalizeClipboardContent({ kind: "image", data: big })).toThrow(
      /exceeds/,
    );
  });

  it("rejects malformed base64", () => {
    expect(() => decodeClipboardBlob("not!valid#base64", 1024)).toThrow(InputError);
  });

  it("rejects non-PNG image payloads even when base64 is valid", () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]).toString("base64");
    expect(() => normalizeClipboardContent({ kind: "image", data: jpg })).toThrow(/PNG/);
  });

  it("rejects empty/invalid kinds and non-string data", () => {
    expect(() => normalizeClipboardContent({ kind: "html", data: "x" })).toThrow(
      InputError,
    );
    expect(() => normalizeClipboardContent({ kind: "text", data: 123 })).toThrow(
      InputError,
    );
    expect(() =>
      normalizeClipboardContent(null as unknown as { kind?: unknown; data?: unknown }),
    ).toThrow(InputError);
  });

  it("computes stable sha256 hex digests", () => {
    const a = normalizeClipboardContent({ kind: "text", data: "hello" });
    const b = normalizeClipboardContent({ kind: "text", data: "hello" });
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256.length).toBe(64);
  });

  it("knows the exact decoded length of padded base64", () => {
    expect(base64DecodedLength(Buffer.from([1, 2, 3]).toString("base64"))).toBe(3);
    expect(base64DecodedLength("AQ==")).toBe(1);
    expect(base64DecodedLength("AQI=")).toBe(2);
  });
});

// ── ownership & conflict resolution ──────────────────────────────────────

describe("ClipboardOwnership — local edits win", () => {
  let owner: ClipboardOwnership;
  beforeEach(() => {
    owner = new ClipboardOwnership();
  });

  it("starts in unknown ownership", () => {
    expect(owner.current()).toBe("unknown");
  });

  it("applies a remote write while ownership is unknown", () => {
    expect(owner.canApplyRemote(null).allowed).toBe(true);
    owner.markRemoteApplied("abc");
    expect(owner.current()).toBe("remote");
  });

  it("rejects a remote write after a local edit (conflict)", () => {
    owner.markRemoteApplied("before");
    owner.markLocalWritten();
    const decision = owner.canApplyRemote("something-local");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("conflict");
  });

  it("re-allows a remote write when the user restores the synced content", () => {
    owner.markRemoteApplied("abc");
    // The user edits locally (ownership flips to local with no hash), then
    // restores the previously synced content exactly.
    owner.markLocalWritten();
    const conflictDecision = owner.canApplyRemote("something-local");
    expect(conflictDecision.allowed).toBe(false);
    owner.markLocalWritten("abc"); // restored to what we synced
    const restored = owner.canApplyRemote("abc");
    expect(restored.allowed).toBe(true);
    expect(restored.reason).toBe("ok");
  });

  it("deduplicates identical consecutive content", () => {
    owner.markRemoteApplied("abc");
    expect(owner.canApplyRemote("abc").reason).toBe("unchanged");
  });
});

// ── controller: apply / dedup / conflict / outbound ──────────────────────

describe("ClipboardController", () => {
  let provider: MockClipboardProvider;
  let controller: ClipboardController;
  let ownership: ClipboardOwnership;

  beforeEach(() => {
    provider = new MockClipboardProvider();
    ownership = new ClipboardOwnership();
    controller = new ClipboardController({ provider, ownership });
  });

  it("applies a remote text write and records calls", async () => {
    const result = await controller.applyRemoteWrite({
      kind: "text",
      data: "remote paste",
    });
    expect(result.applied).toBe(true);
    // One conflict-check read, then the write itself.
    expect(provider.calls.map((c) => c.method)).toEqual(["read", "write"]);
    const write = provider.calls[1] as { method: "write"; input: { data: string } };
    expect(write.input.data).toBe("remote paste");
  });

  it("applies a remote PNG image write", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]).toString("base64");
    const result = await controller.applyRemoteWrite({ kind: "image", data: png });
    expect(result.applied).toBe(true);
    expect(provider.calls[1]?.method).toBe("write");
  });

  it("deduplicates identical content sent twice", async () => {
    const payload = { kind: "text" as const, data: "same" };
    const first = await controller.applyRemoteWrite(payload);
    const second = await controller.applyRemoteWrite(payload);
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.skippedReason).toBe("duplicate");
    // Only the first application touches the provider; the second is
    // short-circuited by the dedup check before any read.
    expect(provider.calls).toHaveLength(2);
  });

  it("rejects oversized payloads with zero provider calls", async () => {
    await expect(
      controller.applyRemoteWrite({ kind: "text", data: "x".repeat(70_000) }),
    ).rejects.toThrow(InputError);
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects non-PNG image data", async () => {
    await expect(
      controller.applyRemoteWrite({
        kind: "image",
        data: Buffer.from("garbage").toString("base64"),
      }),
    ).rejects.toThrow(InputError);
    expect(provider.calls).toHaveLength(0);
  });

  it("drops a remote write when a local edit conflicts", async () => {
    // Simulate a prior sync followed by a local edit.
    const prior = normalizeClipboardContent({ kind: "text", data: "synced" });
    provider.seed(prior);
    ownership.markRemoteApplied(prior.sha256);
    ownership.markLocalWritten();

    await expect(
      controller.applyRemoteWrite({ kind: "text", data: "remote overwrite" }),
    ).rejects.toThrow(InputError);

    const write = provider.calls.find((c) => c.method === "write");
    expect(write).toBeUndefined(); // never touched the clipboard
  });

  it("pushes outbound content and marks it as last-pushed", async () => {
    provider.seed(normalizeClipboardContent({ kind: "text", data: "local copy" }));
    const out = await controller.pushOutbound();
    expect(out?.content.data).toBe("local copy");
    // Second push of the same content is still served (outbound reads the OS,
    // the dedup flag only affects inbound apply), but applies are deduped.
    const result = await controller.applyContent(out!.content);
    expect(result.applied).toBe(false);
    expect(result.skippedReason).toBe("duplicate");
  });

  it("returns null when the clipboard is empty", async () => {
    expect(await controller.pushOutbound()).toBeNull();
  });

  it("clears the clipboard and marks local ownership", async () => {
    await controller.clear();
    expect(provider.calls.find((c) => c.method === "clear")).toBeTruthy();
    expect(ownership.current()).toBe("local");
  });

  it("marks local clipboard written to guard against races", () => {
    controller.markLocalClipboardWritten();
    expect(ownership.current()).toBe("local");
  });
});

// ── controller: encrypted transport ──────────────────────────────────────

describe("ClipboardController — encrypted transport", () => {
  it("round-trips a text payload through AES-256-GCM", async () => {
    const token = "session-token-with-256bit-entropy-suffix";
    const cipher = makePayloadCipher(token)!;
    const provider = new MockClipboardProvider();
    const send = new ClipboardController({ provider, cipher });
    const recv = new ClipboardController({ provider, cipher });

    const content = normalizeClipboardContent({
      kind: "text",
      data: "secret clipboard 🤫",
    });
    const flight = await send.encryptForTransport(content);
    expect((flight as { kind: string }).kind).toBe("encrypted");

    const result = await recv.applyRemoteWrite(flight);
    expect(result.applied).toBe(true);
    const write = provider.calls.find((c) => c.method === "write") as {
      method: "write";
      input: { data: string };
    };
    expect(write.input.data).toBe("secret clipboard 🤫");
  });

  it("rejects a tampered encrypted payload", async () => {
    const cipher = makePayloadCipher("token")!;
    const provider = new MockClipboardProvider();
    const send = new ClipboardController({ provider, cipher });
    const content = normalizeClipboardContent({ kind: "text", data: "tamper me" });
    const flight = (await send.encryptForTransport(content)) as { payload: string };
    // Flip a byte mid-blob — GCM auth tag must fail.
    const buf = Buffer.from(flight.payload, "base64");
    // Flip a byte just before the GCM auth tag — any tampering must fail
    // decryption. The index is provably in range: an AES-GCM blob always
    // carries a 12-byte IV plus a 16-byte tag.
    buf.writeUInt8(
      buf.readUInt8((buf.length - 20) as number) ^ 0xff,
      (buf.length - 20) as number,
    );

    const recv = new ClipboardController({
      provider,
      cipher: makePayloadCipher("token")!,
    });
    await expect(
      recv.applyRemoteWrite({ kind: "encrypted", payload: buf.toString("base64") }),
    ).rejects.toThrow();
    expect(provider.calls).toHaveLength(0);
  });

  it("decrypts with a different key derivation fails", async () => {
    const cipherA = makePayloadCipher("token-a")!;
    const cipherB = makePayloadCipher("token-b")!;
    const provider = new MockClipboardProvider();
    const sender = new ClipboardController({ provider, cipher: cipherA });
    const content = normalizeClipboardContent({ kind: "text", data: "secret" });
    const flight = await sender.encryptForTransport(content);
    const recv = new ClipboardController({ provider, cipher: cipherB });
    await expect(recv.applyRemoteWrite(flight)).rejects.toThrow();
  });
});

// ── providers & factory ──────────────────────────────────────────────────

describe("clipboard providers", () => {
  it("exposes the platform backend table", () => {
    const linux = createNativeClipboardBackend("linux");
    const darwin = createNativeClipboardBackend("darwin");
    const win32 = createNativeClipboardBackend("win32");
    expect(linux.name).toBe("xclip");
    expect(darwin.name).toBe("pbcopy");
    expect(win32.name).toBe("powershell");
  });

  it("throws unsupportedPlatform for unknown runtimes", () => {
    expect(() => createNativeClipboardBackend("aix" as never)).toThrow(InputError);
  });

  it("selects native on supported platforms via the factory", () => {
    const sel = createClipboardProvider({ platform: "linux" });
    expect(sel.kind).toBe("native");
  });

  it("explicit mock kind never probes the OS", () => {
    const sel = createClipboardProvider({ kind: "mock" });
    expect(sel.kind).toBe("mock");
    expect(sel.provider.name).toBe("mock");
  });

  it("unavailable native kind degrades to a tagged mock", () => {
    const sel = createClipboardProvider({ kind: "native", platform: "aix" as never });
    expect(sel.kind).toBe("unavailable");
  });

  it("mock provider records reads, writes, and clears", async () => {
    const mock = new MockClipboardProvider();
    const content = normalizeClipboardContent({ kind: "text", data: "mock" });
    await mock.write(content);
    expect(await mock.read()).toBe(content);
    await mock.clear();
    expect(await mock.read()).toBeNull();
    expect(mock.calls.map((c) => c.method)).toEqual(["write", "read", "clear", "read"]);
  });

  it("mock seed() feeds reads until overwritten", async () => {
    const mock = new MockClipboardProvider();
    const seeded = normalizeClipboardContent({ kind: "text", data: "seeded" });
    mock.seed(seeded);
    expect(await mock.read()).toBe(seeded);
    await mock.write(normalizeClipboardContent({ kind: "text", data: "new" }));
    expect((await mock.read())?.data).toBe("new");
  });
});

describe("makePayloadCipher", () => {
  it("returns null for an empty session token", () => {
    expect(makePayloadCipher("")).toBeNull();
  });

  it("encrypts and decrypts deterministically with random IVs", () => {
    const cipher = makePayloadCipher("test-token")!;
    const a = cipher.encrypt("payload");
    const b = cipher.encrypt("payload");
    expect(a).not.toBe(b); // fresh IV each time
    expect(cipher.decrypt(a)).toBe("payload");
    expect(cipher.decrypt(b)).toBe("payload");
  });

  it("throws on blobs that are too short to hold IV + tag", () => {
    const cipher = makePayloadCipher("test-token")!;
    expect(() => cipher.decrypt(Buffer.from([1, 2, 3]).toString("base64"))).toThrow();
  });
});
