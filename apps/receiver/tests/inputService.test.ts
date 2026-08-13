/**
 * InputService tests — the receiver-side bridge between the wire protocol
 * and the provider-agnostic mouse controller.
 *
 * Coverage goals (Milestone 3):
 *   1. Unauthenticated / un-permissioned sockets are rejected (close 4005).
 *   2. Valid mouse frames delegate to the controller with the right shape.
 *   3. Invalid payloads are rejected without touching the OS input stack.
 *   4. The DI container (inputModule) produces a real pipeline graph.
 */
import {
  ClipboardController,
  FixedMonitors,
  KeyboardController,
  MockClipboardProvider,
  MockKeyboardProvider,
  MockMouseProvider,
  makeTestDisplays,
  type MouseController,
} from "@kbm-remote/input-provider";
import { FrameRouter as _FrameRouterClass } from "@kbm-remote/network";
import { FrameType } from "@kbm-remote/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clipboardControllerToken,
  clipboardProviderToken,
  controllerToken,
  createInputContainer as _reexportCheck,
  createInputContainer,
  keyboardControllerToken,
  monitorToken,
  providerToken,
} from "../src/main/inputModule";
import { InputService } from "../src/main/inputService";

import type { FrameContext, FrameRouter, GatewaySession } from "@kbm-remote/network";
import type { FrameEnvelope } from "@kbm-remote/protocol";

void _FrameRouterClass;

/** Build a dummy frame envelope with a mid. */
function env(
  t: number,
  payload: Record<string, unknown>,
  mid = 1,
): { t: number; mid: number; v: number; ts: number; p: Record<string, unknown> } {
  return { t, mid, v: 1, ts: Date.now(), p: payload };
}

function makeSession(
  opts: {
    authenticated?: boolean;
    permissions?: string[];
    sessionId?: string;
  } = {},
): GatewaySession {
  return {
    authenticated: opts.authenticated ?? false,
    permissions: opts.permissions ?? [],
    sessionId: opts.sessionId ?? "sess-1",
  } as unknown as GatewaySession;
}

function makeRouter(): FrameRouter {
  return new _FrameRouterClass();
}

/** Minimal frame context spy: route() only needs send/close. */
function makeCtx(session: GatewaySession): {
  ctx: FrameContext & { __closed: number | null };
  sent: unknown[];
} {
  const sent: unknown[] = [];
  const ctx = {
    sessionId: session.sessionId,
    authenticated: session.authenticated,
    send: (f: FrameEnvelope) => {
      sent.push(f);
    },
    close: (code: number, reason: string) => {
      void reason;
      ctx.__closed = code;
    },
    __closed: null as number | null,
  } as FrameContext & { __closed: number | null };
  return { ctx, sent };
}

/** A fresh spy ctx for tests that only care about the close code. */
function captureCtx(): { ctx: FrameContext & { __closed: number | null } } {
  return { ctx: makeCtx(makeSession()).ctx };
}

describe("InputService", () => {
  let provider: MockMouseProvider;
  let keyboard: KeyboardController;
  let kbProvider: MockKeyboardProvider;
  let service: InputService;
  let router: FrameRouter;
  let dispatch: (
    session: GatewaySession,
    f: { t: number; mid: number; v: number; ts: number; p: Record<string, unknown> },
    overrideCtx?: FrameContext & { __closed: number | null },
  ) => Promise<{ ctx: FrameContext; sent: unknown[] }>;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new MockMouseProvider();
    kbProvider = new MockKeyboardProvider();
    keyboard = new KeyboardController({
      provider: kbProvider,
      sleep: async () => {},
    });
    const container = createInputContainer();
    container.register(providerToken, () => provider);
    container.register(
      monitorToken,
      () => new FixedMonitors(makeTestDisplays({ secondary: true })),
    );
    container.register(keyboardControllerToken, () => keyboard);

    let currentSession: GatewaySession | undefined;
    service = new InputService(
      container.resolve(controllerToken) as MouseController,
      (sessionId) =>
        currentSession?.sessionId === sessionId ? currentSession : undefined,
    );
    router = makeRouter();
    service.registerHandlers(router);

    dispatch = async (session, f, overrideCtx) => {
      currentSession = session;
      const { ctx, sent } = makeCtx(session);
      const active = overrideCtx ?? ctx;
      const handler = router["handlers"].get(f.t);
      if (handler) await handler(f as never, active);
      return Promise.resolve({ ctx: active, sent });
    };
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("closes with 4005 when the connection is unauthenticated", async () => {
    const session = makeSession({ authenticated: false });
    const { ctx } = captureCtx();
    await dispatch(session, env(FrameType.MouseMove, { x: 0.5, y: 0.5 }), ctx);
    expect(ctx.__closed).toBe(4005);
  });

  it("rejects authenticated sockets without the mouse permission", async () => {
    const session = makeSession({ authenticated: true, permissions: ["keyboard"] });
    const { ctx } = captureCtx();
    await dispatch(
      session,
      env(FrameType.MouseClick, { button: "left", action: "click" }),
      ctx,
    );
    expect(ctx.__closed).toBe(4005);
  });

  it("delegates a valid move to the controller with normalized coords", async () => {
    const session = makeSession({ authenticated: true, permissions: ["mouse"] });
    await dispatch(session, env(FrameType.MouseMove, { x: 0.5, y: 0.25 }));
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toEqual({
      method: "moveAbsolute",
      input: {
        x: expect.any(Number),
        y: expect.any(Number),
        displayIndex: expect.any(Number),
      },
    });
  });

  it("delegates clicks, double click, and scroll actions", async () => {
    const session = makeSession({ authenticated: true, permissions: ["mouse"] });

    await dispatch(
      session,
      env(FrameType.MouseClick, { button: "left", action: "click" }),
    );
    await dispatch(
      session,
      env(FrameType.MouseClick, { button: "right", action: "dblclick" }),
    );
    await dispatch(session, env(FrameType.MouseScroll, { axis: "vertical", amount: 3 }));
    await dispatch(
      session,
      env(FrameType.MouseScroll, { axis: "horizontal", amount: -1 }),
    );

    const methods = provider.calls.map((c) => c.method);
    expect(methods).toEqual(["click", "click", "scroll", "scroll"]);
  });

  it("runs the full drag sequence on the controller", async () => {
    const session = makeSession({ authenticated: true, permissions: ["mouse"] });
    await dispatch(session, env(FrameType.MouseDragStart, { button: "left" }));
    await dispatch(session, env(FrameType.MouseDragMove, { x: 0.3, y: 0.3 }));
    // The controller throttles back-to-back move/drag frames (8 ms default),
    // so advance past the throttle window to let the second sample through.
    vi.advanceTimersByTime(10);
    await dispatch(session, env(FrameType.MouseDragMove, { x: 0.6, y: 0.6 }));
    await dispatch(session, env(FrameType.MouseDragEnd, { button: "left" }));

    const methods = provider.calls.map((c) => c.method);
    expect(methods).toEqual(["dragStart", "dragMove", "dragMove", "dragEnd"]);
  });

  it("rejects mouse frames with invalid payloads (no OS side effects)", async () => {
    const session = makeSession({ authenticated: true, permissions: ["mouse"] });
    await dispatch(session, env(FrameType.MouseMove, { garbage: true }));
    await dispatch(
      session,
      env(FrameType.MouseClick, { button: "hamster", action: "click" }),
    );
    await dispatch(
      session,
      env(FrameType.MouseScroll, { axis: "diagonal", amount: 999 }),
    );
    await dispatch(
      session,
      env(FrameType.MouseDragStart, { button: "right", nonsense: 1 }),
    );
    expect(provider.calls).toHaveLength(0);
  });

  it("registers all twelve mouse and keyboard frame types on the router", () => {
    const types = [
      FrameType.MouseMove,
      FrameType.MouseClick,
      FrameType.MouseScroll,
      FrameType.MouseDragStart,
      FrameType.MouseDragMove,
      FrameType.MouseDragEnd,
      FrameType.KeyPress,
      FrameType.KeyHold,
      FrameType.KeyRelease,
      FrameType.TextInput,
      FrameType.Shortcut,
      FrameType.MediaKey,
      FrameType.ClipboardSync,
      FrameType.ClipboardQuery,
    ];
    for (const t of types) {
      expect(router["handlers"].has(t)).toBe(true);
    }
  });
});

// ── keyboard integration ───────────────────────────────────────────────

describe("InputService — keyboard subsystem", () => {
  let keyboard: KeyboardController;
  let kbProvider: MockKeyboardProvider;
  let service: InputService;
  let router: FrameRouter;
  let dispatch: (
    session: GatewaySession,
    f: { t: number; mid: number; v: number; ts: number; p: Record<string, unknown> },
    overrideCtx?: FrameContext & { __closed: number | null },
  ) => Promise<{ ctx: FrameContext; sent: unknown[] }>;

  beforeEach(() => {
    vi.useFakeTimers();
    kbProvider = new MockKeyboardProvider();
    keyboard = new KeyboardController({ provider: kbProvider, sleep: async () => {} });
    const container = createInputContainer();
    container.register(keyboardControllerToken, () => keyboard);
    container.register(providerToken, () => new MockMouseProvider());
    container.register(monitorToken, () => new FixedMonitors(makeTestDisplays()));

    let currentSession: GatewaySession | undefined;
    service = new InputService(
      container.resolve(controllerToken) as MouseController,
      (sessionId) =>
        currentSession?.sessionId === sessionId ? currentSession : undefined,
      undefined,
      keyboard,
    );
    router = makeRouter();
    service.registerHandlers(router);

    dispatch = async (session, f, overrideCtx) => {
      currentSession = session;
      const { ctx, sent } = makeCtx(session);
      const active = overrideCtx ?? ctx;
      const handler = router["handlers"].get(f.t);
      if (handler) await handler(f as never, active);
      return Promise.resolve({ ctx: active, sent });
    };
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("closes with 4005 when keyboard frames arrive without authentication", async () => {
    const session = makeSession({ authenticated: false });
    const { ctx } = captureCtx();
    await dispatch(session, env(FrameType.KeyPress, { keys: ["F1"] }), ctx);
    expect(ctx.__closed).toBe(4005);
  });

  it("rejects authenticated sockets lacking the keyboard permission", async () => {
    const session = makeSession({ authenticated: true, permissions: ["mouse"] });
    const { ctx } = captureCtx();
    await dispatch(
      session,
      env(FrameType.KeyPress, { keys: ["ControlLeft", "KeyC"] }),
      ctx,
    );
    expect(ctx.__closed).toBe(4005);
  });

  it("gates media keys behind the media permission separately from keyboard", async () => {
    const kbOnly = makeSession({ authenticated: true, permissions: ["keyboard"] });
    const { ctx: ctxKb } = captureCtx();
    await dispatch(kbOnly, env(FrameType.MediaKey, { key: "volumeUp" }), ctxKb);
    expect(ctxKb.__closed).toBe(4005);

    const media = makeSession({ authenticated: true, permissions: ["media"] });
    await dispatch(media, env(FrameType.MediaKey, { key: "playPause" }));
    expect(kbProvider.calls).toEqual([
      { method: "mediaKey", input: { key: "playPause" } },
    ]);
  });

  it("delegates a KeyPress combo and reorders modifiers first", async () => {
    const session = makeSession({ authenticated: true, permissions: ["keyboard"] });
    await dispatch(session, env(FrameType.KeyPress, { keys: ["KeyV", "ControlLeft"] }));
    expect(kbProvider.calls).toEqual([
      { method: "press", input: { keys: ["ControlLeft", "KeyV"] } },
    ]);
  });

  it("runs the hold → release round trip, repeating past the start delay", async () => {
    const session = makeSession({ authenticated: true, permissions: ["keyboard"] });
    await dispatch(
      session,
      env(FrameType.KeyHold, {
        key: "ArrowDown",
        repeatStartMs: 100,
        repeatIntervalMs: 50,
      }),
    );
    vi.advanceTimersByTime(140);
    await vi.advanceTimersByTimeAsync(0);
    const presses = kbProvider.calls.filter((c) => c.method === "press").length;
    expect(presses).toBeGreaterThanOrEqual(2);

    await dispatch(session, env(FrameType.KeyRelease, { key: "ArrowDown" }));
    expect(kbProvider.calls.map((c) => c.method)).toContain("release");
    expect(keyboard.activeRepeatCount).toBe(0);
  });

  it("delegates text input with unicode and rejects oversized payloads", async () => {
    const session = makeSession({ authenticated: true, permissions: ["keyboard"] });
    await dispatch(session, env(FrameType.TextInput, { text: "Héllo 世界" }));
    await dispatch(session, env(FrameType.TextInput, { text: "x".repeat(4100) }));
    await dispatch(session, env(FrameType.TextInput, { text: "" }));
    expect(kbProvider.calls).toEqual([
      { method: "typeText", input: { text: "Héllo 世界" } },
    ]);
  });

  it("delegates a shortcut with the hold window honoured", async () => {
    const session = makeSession({ authenticated: true, permissions: ["keyboard"] });
    await dispatch(
      session,
      env(FrameType.Shortcut, { keys: ["AltLeft", "F4"], holdMs: 20 }),
    );
    vi.advanceTimersByTime(30);
    const methods = kbProvider.calls.map((c) => c.method);
    expect(methods).toEqual(["press", "release", "release"]);
  });

  it("delegates abstract media keys and rejects invalid ones", async () => {
    const session = makeSession({ authenticated: true, permissions: ["media"] });
    await dispatch(session, env(FrameType.MediaKey, { key: "nextTrack" }));
    await dispatch(session, env(FrameType.MediaKey, { key: "volumeMax" }));
    expect(kbProvider.calls).toEqual([
      { method: "mediaKey", input: { key: "nextTrack" } },
    ]);
  });

  it("rejects keyboard frames with invalid payloads (no OS side effects)", async () => {
    const session = makeSession({ authenticated: true, permissions: ["keyboard"] });
    await dispatch(session, env(FrameType.KeyPress, { keys: [] }));
    await dispatch(session, env(FrameType.KeyPress, { keys: ["Cmd"] }));
    await dispatch(session, env(FrameType.KeyHold, { key: 42 }));
    await dispatch(session, env(FrameType.KeyRelease, { key: "Cmd" }));
    await dispatch(session, env(FrameType.TextInput, { text: 123 as unknown }));
    await dispatch(session, env(FrameType.Shortcut, { keys: [] }));
    expect(kbProvider.calls).toHaveLength(0);
  });
});

// ── clipboard integration ──────────────────────────────────────────────

describe("InputService — clipboard subsystem", () => {
  let clipboard: ClipboardController;
  let cbProvider: MockClipboardProvider;
  let service: InputService;
  let router: FrameRouter;
  let dispatch: (
    session: GatewaySession,
    f: { t: number; mid: number; v: number; ts: number; p: Record<string, unknown> },
    overrideCtx?: FrameContext & { __closed: number | null },
  ) => Promise<{ ctx: FrameContext; sent: unknown[] }>;

  beforeEach(() => {
    vi.useFakeTimers();
    cbProvider = new MockClipboardProvider();
    clipboard = new ClipboardController({ provider: cbProvider });
    const container = createInputContainer();
    container.register(clipboardControllerToken, () => clipboard);
    container.register(providerToken, () => new MockMouseProvider());
    container.register(monitorToken, () => new FixedMonitors(makeTestDisplays()));

    let currentSession: GatewaySession | undefined;
    service = new InputService(
      container.resolve(controllerToken) as MouseController,
      (sessionId) =>
        currentSession?.sessionId === sessionId ? currentSession : undefined,
      undefined,
      undefined,
      clipboard,
    );
    router = makeRouter();
    service.registerHandlers(router);

    dispatch = async (session, f, overrideCtx) => {
      currentSession = session;
      const { ctx, sent } = makeCtx(session);
      const active = overrideCtx ?? ctx;
      const handler = router["handlers"].get(f.t);
      if (handler) await handler(f as never, active);
      return Promise.resolve({ ctx: active, sent });
    };
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("closes with 4005 when clipboard frames arrive without authentication", async () => {
    const session = makeSession({ authenticated: false });
    const { ctx } = captureCtx();
    await dispatch(
      session,
      env(FrameType.ClipboardSync, { kind: "text", data: "x" }),
      ctx,
    );
    expect(ctx.__closed).toBe(4005);
  });

  it("rejects authenticated sockets lacking the clipboard permission", async () => {
    const session = makeSession({ authenticated: true, permissions: ["keyboard"] });
    const { ctx } = captureCtx();
    await dispatch(
      session,
      env(FrameType.ClipboardSync, { kind: "text", data: "x" }),
      ctx,
    );
    expect(ctx.__closed).toBe(4005);
  });

  it("gates clipboard frames separately from keyboard and media", async () => {
    const kbOnly = makeSession({ authenticated: true, permissions: ["keyboard"] });
    const { ctx: ctxKb } = captureCtx();
    await dispatch(
      kbOnly,
      env(FrameType.ClipboardSync, { kind: "text", data: "x" }),
      ctxKb,
    );
    expect(ctxKb.__closed).toBe(4005);
    expect(cbProvider.calls).toHaveLength(0);
  });

  it("applies a remote clipboard sync to the OS clipboard", async () => {
    const session = makeSession({ authenticated: true, permissions: ["clipboard"] });
    await dispatch(
      session,
      env(FrameType.ClipboardSync, { kind: "text", data: "synced text" }),
    );
    const write = cbProvider.calls.find((c) => c.method === "write");
    expect(write).toBeDefined();
    expect((write as { input: { data: string } }).input.data).toBe("synced text");
  });

  it("responds to a clipboard query with the local clipboard", async () => {
    const session = makeSession({ authenticated: true, permissions: ["clipboard"] });
    const { normalizeClipboardContent } = await import("@kbm-remote/input-provider");
    cbProvider.seed(normalizeClipboardContent({ kind: "text", data: "receiver copy" }));
    const { sent } = await dispatch(session, env(FrameType.ClipboardQuery, {}));
    await vi.runAllTimersAsync();
    const reply = sent.find((f) => (f as { t: number }).t === FrameType.ClipboardSync);
    expect(reply).toBeDefined();
    expect((reply as { p: { kind: string; data: string } }).p.data).toBe("receiver copy");
  });

  it("skips the query reply when the clipboard is empty", async () => {
    const session = makeSession({ authenticated: true, permissions: ["clipboard"] });
    const { sent } = await dispatch(session, env(FrameType.ClipboardQuery, {}));
    await vi.runAllTimersAsync();
    expect(sent).toHaveLength(0);
  });

  it("drops oversized and invalid clipboard payloads without OS side effects", async () => {
    const session = makeSession({ authenticated: true, permissions: ["clipboard"] });
    await dispatch(
      session,
      env(FrameType.ClipboardSync, { kind: "text", data: "x".repeat(70_000) }),
    );
    await dispatch(
      session,
      env(FrameType.ClipboardSync, { kind: "image", data: "bm90YXBuZw==" }),
    );
    await dispatch(session, env(FrameType.ClipboardSync, { kind: "html", data: "x" }));
    await dispatch(session, env(FrameType.ClipboardSync, { kind: 42, data: "x" }));
    expect(cbProvider.calls).toHaveLength(0);
  });
});

describe("inputModule DI container", () => {
  it("resolves the real pipeline graph (monitors → controller → provider)", async () => {
    const container = createInputContainer();
    // Tests run without a display server, so swap the monitor source for the
    // deterministic test fixture before anything is resolved.
    container.register(monitorToken, () => new FixedMonitors(makeTestDisplays()));
    container.register(providerToken, () => new MockMouseProvider());
    container.register(clipboardProviderToken, () => new MockClipboardProvider());
    const controller = container.resolve(controllerToken);
    const displays = await container.resolve(monitorToken).getDisplays();

    expect(displays.length).toBeGreaterThan(0);
    expect(displays[0]!.scaleFactor).toBeGreaterThan(0);
    expect(controller).toBeDefined();
    // The clipboard graph also resolves — and, in CI without OS clipboard
    // tooling, degrades gracefully to an unavailable mock instead of throwing.
    expect(container.resolve(clipboardControllerToken)).toBeInstanceOf(
      ClipboardController,
    );
    // The controller was built with the container's own provider (not the test
    // factory's, which may fail in CI without a display server — that's fine,
    // construction is side-effect-free).
    expect(container.resolve(providerToken)).toBeDefined();
  });
});
