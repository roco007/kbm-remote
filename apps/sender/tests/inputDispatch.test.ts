import { FrameType } from "@kbm-remote/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clipboardQuery,
  clipboardSync,
  isConnected,
  keyHold,
  keyPress,
  keyRelease,
  mediaKey,
  mouseClick,
  mouseDragEnd,
  mouseDragMove,
  mouseDragStart,
  mouseMove,
  mouseScroll,
  presentationSlide,
  sendInput,
  flushInputCoalescer,
  shortcut,
  textInput,
} from "../src/services/inputDispatch";
// ── Harness ─────────────────────────────────────────────────────────────
//
// `sendInput` reads the connection manager from the Zustand store, so the
// tests swap the store's `manager` in and out of `connection()`'s reach.
// A spy on `ClientConnection.send` confirms the exact envelope shape.
const sent: unknown[] = [];

// Reference object — every static import above is consumed here (lint).
// The tests themselves re-import the module after `vi.doMock` so the mocked
// store is what actually gets exercised at runtime.
const api = {
  sendInput,
  mouseMove,
  mouseClick,
  mouseScroll,
  mouseDragStart,
  mouseDragMove,
  mouseDragEnd,
  keyPress,
  keyHold,
  keyRelease,
  textInput,
  shortcut,
  mediaKey,
  clipboardQuery,
  clipboardSync,
  presentationSlide,
  isConnected,
  flushInputCoalescer,
};
void api;

function installManager(hasManager: boolean, connected = true) {
  vi.doMock("../src/store/connectionStore", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actual = await vi.importActual<any>("../src/store/connectionStore.js");
    const { create } = await import("zustand");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = create<any>(() => ({
      manager: hasManager
        ? {
            connectionRef: {
              connectionState: connected ? "connected" : "reconnecting",
              send: (f: unknown) => sent.push(f),
            },
          }
        : null,
    }));
    return {
      ...actual,
      useConnectionStore: store,
    };
  });
}

// Fresh module so the store mock takes effect before the first import.
vi.resetModules();

describe("inputDispatch — fire-and-forget frame emission", () => {
  it("emits a MouseMove frame with dx/dy when a live connection exists", async () => {
    installManager(true);
    const mod = await import("../src/services/inputDispatch.js");
    const ok = mod.mouseMove(3, -4);
    mod.flushInputCoalescer();
    expect(ok).toBe(true);
    expect(sent[0]).toEqual({
      t: FrameType.MouseMove,
      ts: expect.any(Number),
      p: { dx: 3, dy: -4 },
    });
  });

  it("emits MouseClick frames for all button/action combinations", async () => {
    installManager(true);
    const mod = await import("../src/services/inputDispatch.js");
    void mod.mouseClick("left", "click");
    void mod.mouseClick("right", "dblclick");
    void mod.mouseClick("middle", "up");
    mod.flushInputCoalescer();
    expect(
      sent.slice(0, 3).map((s) => (s as { p: { button: string; action: string } }).p),
    ).toEqual([
      { button: "left", action: "click" },
      { button: "right", action: "dblclick" },
      { button: "middle", action: "up" },
    ]);
  });

  it("emits scroll frames with signed ticks", async () => {
    installManager(true);
    const mod = await import("../src/services/inputDispatch.js");
    void mod.mouseScroll("vertical", 2);
    void mod.mouseScroll("horizontal", -1);
    mod.flushInputCoalescer();
    expect(
      sent.slice(0, 2).map((s) => (s as { p: { axis: string; amount: number } }).p),
    ).toEqual([
      { axis: "vertical", amount: 2 },
      { axis: "horizontal", amount: -1 },
    ]);
  });

  it("emits the full drag trio: start, move, end", async () => {
    installManager(true);
    const mod = await import("../src/services/inputDispatch.js");
    void mod.mouseDragStart("left");
    void mod.mouseDragMove(10, 20);
    void mod.mouseDragEnd("left");
    const types = sent.slice(0, 3).map((s) => (s as { t: number }).t);
    expect(types).toEqual([
      FrameType.MouseDragStart,
      FrameType.MouseDragMove,
      FrameType.MouseDragEnd,
    ]);
  });

  it("emits keyboard frames: press, hold, release, text, shortcut, media", async () => {
    installManager(true);
    const mod = await import("../src/services/inputDispatch.js");
    void mod.keyPress(["a"]);
    void mod.keyHold("b", { repeatStartMs: 400 });
    void mod.keyRelease("b");
    void mod.textInput("hello");
    void mod.shortcut(["Control", "c"]);
    void mod.mediaKey("volumeUp");
    const types = sent.slice(0, 6).map((s) => (s as { t: number }).t);
    expect(types).toEqual([
      FrameType.KeyPress,
      FrameType.KeyHold,
      FrameType.KeyRelease,
      FrameType.TextInput,
      FrameType.Shortcut,
      FrameType.MediaKey,
    ]);
    expect((sent[5] as { p: { key: string } }).p.key).toBe("volumeUp");
  });

  it("emits clipboard query/sync and presentation slide frames", async () => {
    installManager(true);
    const mod = await import("../src/services/inputDispatch.js");
    void mod.clipboardQuery();
    void mod.clipboardSync("text", "pasted");
    void mod.presentationSlide("next");
    mod.flushInputCoalescer();
    const types = sent.slice(0, 3).map((s) => (s as { t: number }).t);
    expect(types).toEqual([
      FrameType.ClipboardQuery,
      FrameType.ClipboardSync,
      FrameType.PresentationSlide,
    ]);
  });

  it("returns false when no manager exists (disconnected)", async () => {
    installManager(false);
    const mod = await import("../src/services/inputDispatch.js");
    expect(mod.mouseMove(1, 1)).toBe(false);
    expect(mod.mediaKey("mute")).toBe(false);
    expect(mod.isConnected()).toBe(false);
  });

  it("returns false when the connection is not yet connected", async () => {
    installManager(true, false);
    const mod = await import("../src/services/inputDispatch.js");
    expect(mod.mouseMove(1, 1)).toBe(false);
    expect(mod.isConnected()).toBe(false);
  });

  it("never attaches mid/v — the network layer injects them (spec §2.3)", async () => {
    installManager(true);
    const mod = await import("../src/services/inputDispatch.js");
    void mod.sendInput(FrameType.MouseMove, { dx: 1, dy: 1 });
    mod.flushInputCoalescer();
    const frame = sent[0] as Record<string, unknown>;
    expect(frame).not.toHaveProperty("mid");
    expect(frame).not.toHaveProperty("v");
    expect(frame).toHaveProperty("t");
    expect(frame).toHaveProperty("ts");
    expect(frame).toHaveProperty("p");
  });

  afterEach(() => {
    sent.length = 0;
    vi.resetModules();
  });
});
