/**
 * Keyboard subsystem tests — pure-controller behaviour over a mock provider,
 * plus provider selection and adapter translation verification.
 *
 * The real OS adapters (nut.js / native) are deliberately not exercised here:
 * they need real input devices and are covered by the receiver integration
 * tests that inject the same mock surface into the full DI graph.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  KeyboardController,
  MEDIA_KEYS,
  MODIFIER_KEYS,
  MockKeyboardProvider,
  createKeyboardController,
  createKeyboardProvider,
  isMediaKey,
  isModifierKey,
  normalizeKeyId,
  utf8ByteLength,
} from "../src";
import { NativeKeyboardProvider } from "../src/providers/keyboardNative";
import { X_KEYS, WIN_VK } from "../src/providers/keyboardNative";

function makeController(options?: { sleep?: (ms: number) => Promise<void> }) {
  const provider = new MockKeyboardProvider();
  const controller = new KeyboardController({
    provider,
    sleep: options?.sleep ?? (async () => {}),
  });
  return { provider, controller };
}

// ── key identifier grammar ─────────────────────────────────────────────

describe("normalizeKeyId — grammar validation", () => {
  it("accepts the protocol letter forms in both cases", () => {
    expect(normalizeKeyId("a")).toBe("A");
    expect(normalizeKeyId("Keyc")).toBe("KeyC");
    expect(normalizeKeyId("Z")).toBe("Z");
  });

  it("accepts digits, function keys and the full layout set", () => {
    expect(normalizeKeyId("5")).toBe("5");
    expect(normalizeKeyId("F1")).toBe("F1");
    expect(normalizeKeyId("F24")).toBe("F24");
    expect(normalizeKeyId("Space")).toBe("Space");
    expect(normalizeKeyId("Backquote")).toBe("Backquote");
  });

  it("accepts the four modifier sides and media keys", () => {
    for (const m of MODIFIER_KEYS) expect(normalizeKeyId(m)).toBe(m);
    for (const k of MEDIA_KEYS) expect(normalizeKeyId(k)).toBe(k);
  });

  it("rejects unknown, empty and non-string identifiers", () => {
    for (const bad of ["Cmd", "Ctrl", "", 42, null, "F25", "ArrowHome"]) {
      expect(() => normalizeKeyId(bad)).toThrow();
    }
  });
});

describe("modifier / media predicates", () => {
  it("isModifierKey narrows the eight modifier identifiers", () => {
    expect(isModifierKey("ControlLeft")).toBe(true);
    expect(isModifierKey("MetaRight")).toBe(true);
    expect(isModifierKey("F4")).toBe(false);
    expect(isModifierKey(42)).toBe(false);
  });

  it("isMediaKey narrows only the abstract media set", () => {
    expect(isMediaKey("volumeUp")).toBe(true);
    expect(isMediaKey("nextTrack")).toBe(true);
    expect(isMediaKey("AudioPlay")).toBe(false);
  });
});

describe("utf8ByteLength — TextInput boundary", () => {
  it("counts ASCII, multibyte and surrogate pairs correctly", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("€")).toBe(3);
    expect(utf8ByteLength("😊")).toBe(4); // surrogate pair
    expect(utf8ByteLength("日")).toBe(3);
  });
});

// ── controller behaviour ───────────────────────────────────────────────

describe("KeyboardController — pressKeys", () => {
  it("delegates an atomic combo after modifier-first reordering", async () => {
    const { provider, controller } = makeController();
    await controller.pressKeys({ keys: ["KeyC", "ControlLeft", "ShiftLeft"] });
    expect(provider.calls).toEqual([
      {
        method: "press",
        input: { keys: ["ControlLeft", "ShiftLeft", "KeyC"] },
      },
    ]);
  });

  it("rejects empty key arrays before touching the provider", async () => {
    const { provider, controller } = makeController();
    await expect(controller.pressKeys({ keys: [] })).rejects.toThrow();
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects invalid key identifiers without provider side effects", async () => {
    const { provider, controller } = makeController();
    await expect(controller.pressKeys({ keys: ["Cmd"] })).rejects.toThrow();
    expect(provider.calls).toHaveLength(0);
  });
});

describe("KeyboardController — shortcut", () => {
  it("presses, holds, then releases in modifiers-last order", async () => {
    const { provider, controller } = makeController();
    await controller.shortcut({ keys: ["ControlLeft", "KeyV"], holdMs: 50 });
    expect(provider.calls).toEqual([
      { method: "press", input: { keys: ["ControlLeft", "KeyV"] } },
      { method: "release", input: { key: "KeyV" } },
      { method: "release", input: { key: "ControlLeft" } },
    ]);
  });

  it("rejects single-key shortcuts", async () => {
    const { provider, controller } = makeController();
    await expect(controller.shortcut({ keys: ["F1"] })).rejects.toThrow();
    expect(provider.calls).toHaveLength(0);
  });

  it("honours the injected sleep for the hold window", async () => {
    const sleep = vi.fn(async () => {});
    const { controller } = makeController({ sleep });
    await controller.shortcut({ keys: ["AltLeft", "F4"], holdMs: 77 });
    expect(sleep).toHaveBeenCalledWith(77);
  });
});

describe("KeyboardController — hold / release and key repeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("holds until release with no application-level repeat by default", async () => {
    const { provider, controller } = makeController();
    await controller.holdKey({ key: "Space" });
    expect(provider.calls).toEqual([{ method: "press", input: { keys: ["Space"] } }]);
    await controller.releaseKey({ key: "Space" });
    expect(provider.calls).toEqual([
      { method: "press", input: { keys: ["Space"] } },
      { method: "release", input: { key: "Space" } },
    ]);
    expect(controller.activeRepeatCount).toBe(0);
  });

  it("re-presses the held key on the configured interval after the start delay", async () => {
    const { provider, controller } = makeController();
    const armed = controller.holdKey({
      key: "ArrowDown",
      repeatStartMs: 100,
      repeatIntervalMs: 50,
    });
    vi.advanceTimersByTime(140);
    await armed;
    vi.advanceTimersByTime(130);
    await vi.advanceTimersByTimeAsync(0); // flush microtask repeats
    const presses = provider.calls.filter((c) => c.method === "press").length;
    expect(presses).toBeGreaterThanOrEqual(2);
    expect(controller.activeRepeatCount).toBe(1);
    await controller.releaseKey({ key: "ArrowDown" });
    expect(controller.activeRepeatCount).toBe(0);
    vi.useRealTimers();
  });

  it("rejects holding a key that is already held", async () => {
    const { controller } = makeController();
    await controller.holdKey({
      key: "ArrowUp",
      repeatStartMs: 100,
      repeatIntervalMs: 50,
    });
    vi.advanceTimersByTime(120);
    await expect(
      controller.holdKey({ key: "ArrowUp", repeatStartMs: 100, repeatIntervalMs: 50 }),
    ).rejects.toThrow(/already held/);
    vi.useRealTimers();
  });

  it("ignores invalid repeat windows (start <= 0 or interval < 30 ms) as plain holds", async () => {
    const { provider, controller } = makeController();
    await controller.holdKey({
      key: "KeyA",
      repeatStartMs: 0,
      repeatIntervalMs: 10,
    });
    await controller.releaseKey({ key: "KeyA" });
    expect(provider.calls).toEqual([
      { method: "press", input: { keys: ["KeyA"] } },
      { method: "release", input: { key: "KeyA" } },
    ]);
  });
});

describe("KeyboardController — text and media", () => {
  it("delegates unicode text and enforces the 4 KB boundary", async () => {
    const { provider, controller } = makeController();
    await controller.typeText({ text: "Привет 世界 🌍" });
    expect(provider.calls).toEqual([
      { method: "typeText", input: { text: "Привет 世界 🌍" } },
    ]);
    const big = "a".repeat(4100); // 4100 ASCII bytes > 4096
    await expect(controller.typeText({ text: big })).rejects.toThrow(/too large/i);
  });

  it("rejects empty text", async () => {
    const { provider, controller } = makeController();
    await expect(controller.typeText({ text: "" })).rejects.toThrow(/empty/i);
    expect(provider.calls).toHaveLength(0);
  });

  it("delegates abstract media keys and rejects unknown ones", async () => {
    const { provider, controller } = makeController();
    await controller.mediaKey({ key: "volumeUp" });
    expect(provider.calls).toEqual([
      { method: "mediaKey", input: { key: "volumeUp" } },
    ]);
    await expect(controller.mediaKey({ key: "volumeMax" })).rejects.toThrow();
  });
});

// ── provider selection ─────────────────────────────────────────────────

describe("createKeyboardProvider", () => {
  it("returns the nutjs selection by default", () => {
    const selection = createKeyboardProvider();
    expect(selection.kind).toBe("nutjs");
    expect(selection.provider.name).toBe("nutjs");
  });

  it("returns a mock when explicitly requested", () => {
    const selection = createKeyboardProvider({ kind: "mock" });
    expect(selection.kind).toBe("mock");
  });

  it("falls back to unavailable mock on unknown kinds", () => {
    const selection = createKeyboardProvider({ kind: "web" } as never);
    expect(selection.kind).toBe("unavailable");
  });
});

describe("createKeyboardController convenience", () => {
  it("builds a working controller with the default selection", async () => {
    const selection = createKeyboardController({
      kind: "mock",
      sleep: async () => {},
    });
    const spy = new MockKeyboardProvider();
    const controlled = new KeyboardController({
      provider: spy,
      sleep: async () => {},
    });
    await controlled.pressKeys({ keys: ["F5"] });
    expect(spy.calls).toEqual([{ method: "press", input: { keys: ["F5"] } }]);
    expect(selection.kind).toBe("mock");
  });
});

// ── native adapter translation tables ──────────────────────────────────

describe("native backend code maps", () => {
  it("covers every modifier and media key on Linux and Windows", () => {
    for (const m of MODIFIER_KEYS) {
      expect(X_KEYS[m]).toBeDefined();
      expect(WIN_VK[m]).toBeDefined();
    }
    for (const k of MEDIA_KEYS) {
      expect(X_KEYS[k]).toBeDefined();
      expect(WIN_VK[k]).toBeDefined();
    }
  });

  it("builds per-platform native providers without throwing", () => {
    expect(() => new NativeKeyboardProvider()).not.toThrow();
  });
});
