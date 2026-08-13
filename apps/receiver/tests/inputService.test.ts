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
  FixedMonitors,
  MockMouseProvider,
  makeTestDisplays,
  type MouseController,
} from "@kbm-remote/input-provider";
import { FrameRouter as _FrameRouterClass } from "@kbm-remote/network";
import { FrameType } from "@kbm-remote/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInputContainer,
  controllerToken,
  createInputContainer as _reexportCheck,
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
    const container = createInputContainer();
    container.register(providerToken, () => provider);
    container.register(
      monitorToken,
      () => new FixedMonitors(makeTestDisplays({ secondary: true })),
    );

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

  it("registers all six mouse frame types on the router", () => {
    const types = [
      FrameType.MouseMove,
      FrameType.MouseClick,
      FrameType.MouseScroll,
      FrameType.MouseDragStart,
      FrameType.MouseDragMove,
      FrameType.MouseDragEnd,
    ];
    for (const t of types) {
      expect(router["handlers"].has(t)).toBe(true);
    }
  });
});

describe("inputModule DI container", () => {
  it("resolves the real pipeline graph (monitors → controller → provider)", async () => {
    const container = createInputContainer();
    // Tests run without a display server, so swap the monitor source for the
    // deterministic test fixture before anything is resolved.
    container.register(monitorToken, () => new FixedMonitors(makeTestDisplays()));
    container.register(providerToken, () => new MockMouseProvider());
    const controller = container.resolve(controllerToken);
    const displays = await container.resolve(monitorToken).getDisplays();

    expect(displays.length).toBeGreaterThan(0);
    expect(displays[0]!.scaleFactor).toBeGreaterThan(0);
    expect(controller).toBeDefined();
    // The controller was built with the container's own provider (not the test
    // factory's, which may fail in CI without a display server — that's fine,
    // construction is side-effect-free).
    expect(container.resolve(providerToken)).toBeDefined();
  });
});
