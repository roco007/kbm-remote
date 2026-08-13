import { beforeEach, describe, expect, it } from "vitest";

import {
  Container,
  DEFAULT_INPUT_THROTTLE_MS,
  DisplayInfo,
  DRAG_BUTTONS,
  isDragButton,
  isMouseButton,
  MockMouseProvider,
  MouseController,
  MouseProvider,
  SCROLL_CLAMP,
  Token,
  createMouseProvider,
} from "../src";
import { FixedMonitors, makeTestDisplays } from "../src/providers/mock";
import { createNativeBackend } from "../src/providers/native";

// ── fixtures ───────────────────────────────────────────────────────────

function makeController(overrides?: {
  inputThrottleMs?: number;
  now?: () => number;
  displays?: DisplayInfo[];
}) {
  const provider = new MockMouseProvider();
  const displays = overrides?.displays ?? makeTestDisplays({ secondary: true });
  const monitors = new FixedMonitors(displays);
  let nowMs = 0;
  const now = overrides?.now ?? (() => nowMs);
  const controller = new MouseController({
    provider,
    monitors,
    now,
    inputThrottleMs: overrides?.inputThrottleMs ?? DEFAULT_INPUT_THROTTLE_MS,
  });
  return {
    provider,
    displays,
    controller,
    /** Advance the injectable clock and return the new time. */
    tick(ms: number) {
      nowMs += ms;
      return nowMs;
    },
  };
}

// ── absolute movement + multi-monitor ──────────────────────────────────

describe("MouseController — absolute movement", () => {
  it("maps normalized (1, 1) of the primary display to its bottom-right corner", async () => {
    const { provider, controller } = makeController();
    await controller.moveAbsolute({ x: 1, y: 1, displayIndex: 0 });
    expect(provider.calls).toEqual([
      { method: "moveAbsolute", input: { x: 1920, y: 1080, displayIndex: 0 } },
    ]);
  });

  it("maps normalized (0, 0) to the display's virtual origin", async () => {
    const { provider, controller } = makeController();
    await controller.moveAbsolute({ x: 0, y: 0, displayIndex: 0 });
    expect(provider.calls[0]?.input).toEqual({ x: 0, y: 0, displayIndex: 0 });
  });

  it("translates secondary-display normalized coords into virtual units offset by its origin", async () => {
    const { provider, controller } = makeController();
    // Secondary: origin (1920, 0), 2560x1440. Midpoint of that display:
    await controller.moveAbsolute({ x: 0.5, y: 0.5, displayIndex: 1 });
    expect(provider.calls[0]?.input).toEqual({
      x: 1920 + 1280,
      y: 0 + 720,
      displayIndex: 1,
    });
  });

  it("clamps out-of-range normalized coordinates to the display edges", async () => {
    const { provider, controller } = makeController();
    await controller.moveAbsolute({ x: -3, y: 9, displayIndex: 1 });
    expect(provider.calls[0]?.input).toEqual({ x: 1920, y: 1440, displayIndex: 1 });
  });

  it("falls back to the current display when no displayIndex is given", async () => {
    const displays = makeTestDisplays({ secondary: true });
    const { provider, controller } = makeController({ displays });
    // FixedMonitors.currentDisplay returns the first (primary) display.
    await controller.moveAbsolute({ x: 0.25, y: 0.25 });
    expect((provider.calls[0]?.input as { displayIndex: number }).displayIndex).toBe(0);
  });

  it("falls back to the primary display when the requested index is unknown", async () => {
    const { provider, controller } = makeController();
    await controller.moveAbsolute({ x: 1, y: 1, displayIndex: 99 });
    expect((provider.calls[0]?.input as { displayIndex: number }).displayIndex).toBe(0);
  });

  it("throws noDisplays when the OS reports no connected displays", async () => {
    const { controller } = makeController({ displays: [] });
    await expect(controller.moveAbsolute({ x: 0.5, y: 0.5 })).rejects.toMatchObject({
      reason: "noDisplays",
    });
  });

  it("rounds fractional virtual units to integers", async () => {
    const { provider, controller } = makeController();
    await controller.moveAbsolute({ x: 0.3333, y: 0.6666, displayIndex: 0 });
    const input = provider.calls[0]?.input as { x: number; y: number };
    expect(Number.isInteger(input.x) && Number.isInteger(input.y)).toBe(true);
  });
});

// ── relative movement ──────────────────────────────────────────────────

describe("MouseController — relative movement", () => {
  it("passes rounded pixel deltas through", async () => {
    const { provider, controller } = makeController();
    await controller.moveRelative({ dx: 10.9, dy: -7.2 });
    expect(provider.calls[0]?.input).toEqual({ dx: 11, dy: -7 });
  });
});

// ── clicks ─────────────────────────────────────────────────────────────

describe("MouseController — clicks", () => {
  it("forwards all button/action combinations", async () => {
    const { provider, controller } = makeController();
    for (const button of ["left", "right", "middle"] as const) {
      for (const action of ["click", "dblclick", "down", "up"] as const) {
        await controller.click({ button, action });
      }
    }
    expect(provider.calls.length).toBe(12);
    expect(provider.calls[0]?.input).toEqual({ button: "left", action: "click" });
    expect(provider.calls[11]?.input).toEqual({ button: "middle", action: "up" });
  });

  it("rejects unknown button values at the protocol boundary", async () => {
    const { controller } = makeController();
    await expect(
      controller.click({ button: "back" as never, action: "click" }),
    ).rejects.toMatchObject({ reason: "invalidButton" });
  });
});

// ── scroll ─────────────────────────────────────────────────────────────

describe("MouseController — scroll", () => {
  it("clamps large scroll amounts to the protocol band", async () => {
    const { provider, controller } = makeController();
    await controller.scroll({ axis: "vertical", amount: 1000 });
    expect(provider.calls[0]?.input).toEqual({ axis: "vertical", amount: SCROLL_CLAMP });
  });

  it("preserves direction for negative and horizontal scrolls", async () => {
    const { provider, controller } = makeController();
    await controller.scroll({ axis: "horizontal", amount: -3 });
    expect(provider.calls[0]?.input).toEqual({ axis: "horizontal", amount: -3 });
  });

  it("drops zero-scroll no-ops", async () => {
    const { provider, controller } = makeController();
    await controller.scroll({ axis: "vertical", amount: 0 });
    await controller.scroll({ axis: "vertical", amount: 0.0001 });
    expect(provider.calls).toHaveLength(1);
  });
});

// ── drag state machine ─────────────────────────────────────────────────

describe("MouseController — drag state machine", () => {
  it("performs a full left-button drag with normalized drag moves", async () => {
    const { provider, controller } = makeController();
    await controller.dragStart({ button: "left" });
    await controller.dragMove({ x: 0.5, y: 0.5, displayIndex: 1 });
    await controller.dragEnd({ button: "left" });
    expect(provider.calls.map((c) => c.method)).toEqual([
      "dragStart",
      "dragMove",
      "dragEnd",
    ]);
    expect(controller.isDragActive).toBe(false);
    // dragMove mapped to the secondary display's midpoint in virtual units
    expect((provider.calls[1]?.input as { x: number }).x).toBe(3200);
  });

  it("rejects dragMove and dragEnd before dragStart", async () => {
    const { controller } = makeController();
    await expect(controller.dragMove({ x: 0.5, y: 0.5 })).rejects.toMatchObject({
      reason: "dragNotStarted",
    });
    await expect(controller.dragEnd({ button: "left" })).rejects.toMatchObject({
      reason: "dragNotStarted",
    });
  });

  it("rejects a second dragStart while a drag is active", async () => {
    const { controller } = makeController();
    await controller.dragStart({ button: "left" });
    await expect(controller.dragStart({ button: "middle" })).rejects.toMatchObject({
      reason: "dragAlreadyStarted",
    });
  });

  it("only allows left and middle buttons to drive drags", async () => {
    const { controller } = makeController();
    await expect(
      controller.dragStart({ button: "right" as never }),
    ).rejects.toMatchObject({
      reason: "invalidButton",
    });
    expect(DRAG_BUTTONS).toEqual(["left", "middle"]);
  });
});

// ── input rate limiting ────────────────────────────────────────────────

describe("MouseController — input throttling", () => {
  it("accepts the first move and drops samples inside the throttle window", async () => {
    const { provider, controller, tick } = makeController({ inputThrottleMs: 10 });
    await controller.moveAbsolute({ x: 0.1, y: 0.1, displayIndex: 0 });
    tick(4); // inside window
    await controller.moveAbsolute({ x: 0.2, y: 0.2, displayIndex: 0 });
    tick(4); // inside window
    await controller.moveAbsolute({ x: 0.3, y: 0.3, displayIndex: 0 });
    expect(provider.calls).toHaveLength(1);
  });

  it("re-accepts samples once the throttle window elapses", async () => {
    const { provider, controller, tick } = makeController({ inputThrottleMs: 10 });
    await controller.moveAbsolute({ x: 0.1, y: 0.1, displayIndex: 0 });
    tick(10);
    await controller.moveAbsolute({ x: 0.2, y: 0.2, displayIndex: 0 });
    tick(10);
    await controller.moveAbsolute({ x: 0.3, y: 0.3, displayIndex: 0 });
    expect(provider.calls).toHaveLength(3);
  });

  it("throttles drag moves and relative moves by the same window", async () => {
    const { provider, controller, tick } = makeController({ inputThrottleMs: 10 });
    await controller.dragStart({ button: "left" });
    await controller.dragMove({ x: 0.5, y: 0.5, displayIndex: 0 });
    tick(4); // t=4 — second dragMove falls inside the throttle window → dropped
    await controller.dragMove({ x: 0.6, y: 0.6, displayIndex: 0 });
    tick(5); // t=9 — relative move still inside the window (9 − 0 < 10) → dropped
    await controller.moveRelative({ dx: 5, dy: 5 });
    await controller.dragEnd({ button: "left" });
    // Only the first dragMove and the dragEnd reach the provider.
    expect(provider.calls.map((c) => c.method)).toEqual([
      "dragStart",
      "dragMove",
      "dragEnd",
    ]);
  });

  it("uses the injectable clock so tests are deterministic", async () => {
    let clock = 0;
    const { provider, controller } = makeController({
      inputThrottleMs: 10,
      now: () => clock,
    });
    await controller.moveAbsolute({ x: 0.1, y: 0.1, displayIndex: 0 });
    clock = 5;
    await controller.moveAbsolute({ x: 0.2, y: 0.2, displayIndex: 0 });
    clock = 20;
    await controller.moveAbsolute({ x: 0.3, y: 0.3, displayIndex: 0 });
    expect(provider.calls).toHaveLength(2);
  });
});

// ── protocol boundary validation ───────────────────────────────────────

describe("protocol boundary validation", () => {
  it("isMouseButton accepts the three protocol buttons only", () => {
    expect(isMouseButton("left")).toBe(true);
    expect(isMouseButton("middle")).toBe(true);
    expect(isMouseButton("right")).toBe(true);
    expect(isMouseButton("back")).toBe(false);
    expect(isMouseButton(42)).toBe(false);
  });

  it("isDragButton accepts left/middle only", () => {
    expect(isDragButton("left")).toBe(true);
    expect(isDragButton("right")).toBe(false);
  });
});

// ── dependency injection ───────────────────────────────────────────────

describe("Container — dependency injection", () => {
  const mouseToken = new Token<MouseProvider>("MouseProvider");
  const throttleToken = new Token<number>("throttleMs");

  it("resolves singleton registrations by reference", () => {
    const container = new Container();
    const provider = new MockMouseProvider();
    container.registerValue(mouseToken, provider);
    expect(container.resolve(mouseToken)).toBe(provider);
  });

  it("throws a descriptive error for unregistered dependencies", () => {
    const container = new Container();
    expect(() => container.resolve(mouseToken)).toThrow(/No registration/);
  });

  it("builds transient registrations anew on every resolve", () => {
    const container = new Container();
    container.register(mouseToken, () => new MockMouseProvider(), "transient");
    expect(container.resolve(mouseToken)).not.toBe(container.resolve(mouseToken));
  });

  it("composes a real service graph: controller built from registered deps", async () => {
    const controllerToken = new Token<MouseController>("MouseController");
    const monitorsToken = new Token<FixedMonitors>("Monitors");

    const container = new Container();
    const spyProvider = new MockMouseProvider();
    container
      .registerValue(mouseToken, spyProvider)
      .registerValue(throttleToken, 8)
      .registerValue(
        monitorsToken,
        new FixedMonitors(makeTestDisplays({ secondary: true })),
      )
      .register(
        controllerToken,
        (c) =>
          new MouseController({
            provider: c.resolve(mouseToken),
            monitors: c.resolve(monitorsToken),
            inputThrottleMs: c.resolve(throttleToken),
          }),
      );

    // The controller resolves its provider through the container, so whatever
    // is registered under MouseProvider drives the whole graph.
    const controller = container.resolve(controllerToken);
    await controller.moveAbsolute({ x: 1, y: 1, displayIndex: 0 });
    expect(spyProvider.calls).toHaveLength(1);

    // Already-built singletons are NOT rebuilt by a later re-registration —
    // the container re-routes only dependencies that have not yet been
    // resolved. This is documented, deliberate behavior: consumers keep the
    // instance they were constructed with.
    const replacement = new MockMouseProvider();
    container.registerValue(mouseToken, replacement);
    const controller2 = container.resolve(controllerToken);
    expect(controller2).toBe(controller); // same cached singleton
    expect(replacement.calls).toHaveLength(0); // never wired into the old graph
  });
});

// ── provider factory + platform backends ───────────────────────────────

describe("createMouseProvider — factory selection", () => {
  it("returns the mock provider on explicit request", () => {
    const selection = createMouseProvider({ kind: "mock" });
    expect(selection.kind).toBe("mock");
    expect(selection.provider.name).toBe("mock");
  });

  it("selects the nutjs provider by default without loading native bindings", () => {
    const selection = createMouseProvider();
    expect(selection.kind).toBe("nutjs");
    expect(selection.provider.name).toBe("nutjs");
  });

  it("rejects explicit-native selection on an unsupported platform", () => {
    expect(() =>
      createMouseProvider({ kind: "native", platform: "haiku" as never }),
    ).toThrow(/no native mouse backend/);
  });

  it("builds the native backend for linux/darwin/win32", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const backend = createNativeBackend(platform);
      expect(backend.name).toContain(platform);
    }
  });
});

// ── harness smoke: FixedMonitors / fixtures ────────────────────────────

describe("test fixtures", () => {
  let provider: MockMouseProvider;
  beforeEach(() => {
    provider = new MockMouseProvider();
  });

  it("records a complete send-session in call order", async () => {
    const controller = new MouseController({
      provider,
      monitors: new FixedMonitors(makeTestDisplays({ secondary: true })),
      inputThrottleMs: 0,
    });
    await controller.moveAbsolute({ x: 0.5, y: 0.5, displayIndex: 0 });
    await controller.click({ button: "right", action: "click" });
    await controller.scroll({ axis: "vertical", amount: 3 });
    await controller.dragStart({ button: "left" });
    await controller.dragMove({ x: 0.5, y: 0.5, displayIndex: 0 });
    await controller.dragEnd({ button: "left" });
    expect(provider.calls.map((c) => c.method)).toEqual([
      "moveAbsolute",
      "click",
      "scroll",
      "dragStart",
      "dragMove",
      "dragEnd",
    ]);
  });
});
