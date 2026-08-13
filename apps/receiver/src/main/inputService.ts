/**
 * InputService — receiver-side command handler for the mouse subsystem.
 *
 * Sits between the WebSocket gateway (untrusted protocol frames) and the
 * {@link MouseController} (trusted, normalized input). Responsibilities:
 *
 *   1. **Permission gate** — every mouse frame must arrive on an
 *      authenticated session that holds the "mouse" permission scope;
 *      others are rejected with close code 4005 (RateLimited).
 *   2. **Validation** — payload fields are checked against the protocol
 *      boundary validators in `@kbm-remote/input-provider` before reaching
 *      the controller.
 *   3. **Delegation** — dispatches to the injected MouseController, which is
 *      itself provider-agnostic (platform adapters live in the
 *      input-provider package and are composed through the DI container).
 *
 * All input frames are fire-and-forget: handlers never send replies, which
 * keeps the mouse path at the lowest possible latency.
 */
import { isDragButton, isMouseButton, MouseController } from "@kbm-remote/input-provider";
import { FrameContext, FrameRouter, type GatewaySession } from "@kbm-remote/network";
import { FrameType, type FrameEnvelope } from "@kbm-remote/protocol";

export const MOUSE_PERMISSION = "mouse";

/** Optional logger — keeps the service testable without pulling a framework. */
export interface ServiceLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export const consoleLog: ServiceLog = {
  info: console.info,
  warn: console.warn,
};

export class InputService {
  constructor(
    private readonly controller: MouseController,
    /** Looks up the gateway session attached to the frame's socket id. */
    private readonly sessionLookup: (sessionId: string) => GatewaySession | undefined,
    private readonly log: ServiceLog = consoleLog,
  ) {}

  /** Registers every mouse frame handler with the gateway's frame router. */
  registerHandlers(router: FrameRouter): void {
    router.register(FrameType.MouseMove, async (f, ctx) => {
      this.handleMove(f, ctx);
      return { ok: true };
    });
    router.register(FrameType.MouseClick, async (f, ctx) => {
      this.handleClick(f, ctx);
      return { ok: true };
    });
    router.register(FrameType.MouseScroll, async (f, ctx) => {
      this.handleScroll(f, ctx);
      return { ok: true };
    });
    router.register(FrameType.MouseDragStart, async (f, ctx) => {
      this.handleDragStart(f, ctx);
      return { ok: true };
    });
    router.register(FrameType.MouseDragMove, async (f, ctx) => {
      this.handleDragMove(f, ctx);
      return { ok: true };
    });
    router.register(FrameType.MouseDragEnd, async (f, ctx) => {
      this.handleDragEnd(f, ctx);
      return { ok: true };
    });
  }

  // ── permission gate ──────────────────────────────────────────────────

  private hasMousePermission(ctx: FrameContext): boolean {
    if (!ctx.authenticated || !ctx.sessionId) {
      ctx.close(4005, "not authenticated");
      this.log.warn("mouse frame rejected: unauthenticated session");
      return false;
    }
    const session = this.sessionLookup(ctx.sessionId);
    const granted = session?.permissions?.includes(MOUSE_PERMISSION) ?? false;
    if (!granted) {
      ctx.close(4005, "missing mouse permission");
      this.log.warn("mouse frame rejected: session lacks 'mouse' permission");
    }
    return granted;
  }

  // ── frame handlers (fire-and-forget) ─────────────────────────────────

  private handleMove(f: FrameEnvelope, ctx: FrameContext): void {
    if (!this.hasMousePermission(ctx)) return;
    const p = f.p as Record<string, unknown>;
    if (!p) return;
    if (typeof p.x === "number" && typeof p.y === "number") {
      void this.controller.moveAbsolute({
        x: p.x as number,
        y: p.y as number,
        displayIndex:
          typeof p.displayIndex === "number" ? (p.displayIndex as number) : undefined,
      });
      return;
    }
    if (typeof p.dx === "number" && typeof p.dy === "number") {
      void this.controller.moveRelative({ dx: p.dx as number, dy: p.dy as number });
      return;
    }
    this.log.warn("mouse move frame rejected: missing coordinates");
  }

  private handleClick(f: FrameEnvelope, ctx: FrameContext): void {
    if (!this.hasMousePermission(ctx)) return;
    const p = f.p as Record<string, unknown>;
    if (!p) return;
    if (!isMouseButton(p.button) || !isClickAction(p.action)) {
      this.log.warn("mouse click frame rejected: invalid button/action");
      return;
    }
    void this.controller.click({ button: p.button, action: p.action });
  }

  private handleScroll(f: FrameEnvelope, ctx: FrameContext): void {
    if (!this.hasMousePermission(ctx)) return;
    const p = f.p as Record<string, unknown>;
    if (!p) return;
    if (
      (p.axis !== "vertical" && p.axis !== "horizontal") ||
      typeof p.amount !== "number"
    ) {
      this.log.warn("mouse scroll frame rejected: invalid axis/amount");
      return;
    }
    void this.controller.scroll({
      axis: p.axis as "vertical" | "horizontal",
      amount: p.amount,
    });
  }

  private handleDragStart(f: FrameEnvelope, ctx: FrameContext): void {
    if (!this.hasMousePermission(ctx)) return;
    const p = f.p as Record<string, unknown>;
    if (!p || !isDragButton(p.button)) {
      this.log.warn("mouse dragStart rejected: invalid button");
      return;
    }
    void this.controller.dragStart({ button: p.button }).catch((err: unknown) => {
      this.log.warn(`dragStart failed: ${(err as Error).message}`);
    });
  }

  private handleDragMove(f: FrameEnvelope, ctx: FrameContext): void {
    if (!this.hasMousePermission(ctx)) return;
    const p = f.p as Record<string, unknown>;
    if (!p) return;
    // Drag follows an absolute normalized path (§4.5 of the protocol spec):
    // relative drags are not representable because the drag head must stay on
    // a deterministic screen-space trajectory for the OS grab to track it.
    if (typeof p.x !== "number" || typeof p.y !== "number") {
      this.log.warn("mouse dragMove rejected: absolute x/y coordinates required");
      return;
    }
    void this.controller.dragMove({ x: p.x, y: p.y });
  }

  private handleDragEnd(f: FrameEnvelope, ctx: FrameContext): void {
    if (!this.hasMousePermission(ctx)) return;
    const p = f.p as Record<string, unknown>;
    if (!p || !isDragButton(p.button)) {
      this.log.warn("mouse dragEnd rejected: invalid button");
      return;
    }
    void this.controller.dragEnd({ button: p.button }).catch((err: unknown) => {
      this.log.warn(`dragEnd failed: ${(err as Error).message}`);
    });
  }
}

function isClickAction(value: unknown): value is "click" | "dblclick" | "down" | "up" {
  return value === "click" || value === "dblclick" || value === "down" || value === "up";
}
