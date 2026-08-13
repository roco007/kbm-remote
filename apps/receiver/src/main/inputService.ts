/**
 * InputService — receiver-side command handler for the mouse and keyboard
 * subsystems.
 *
 * Sits between the WebSocket gateway (untrusted protocol frames) and the
 * controllers (trusted, normalized input). Responsibilities:
 *
 *   1. **Permission gate** — every input frame must arrive on an
 *      authenticated session that holds the matching permission scope
 *      ("mouse", "keyboard", "media"); others are rejected with close
 *      code 4005 (RateLimited).
 *   2. **Validation** — payload fields are checked against the protocol
 *      boundary validators in `@kbm-remote/input-provider` before reaching
 *      a controller.
 *   3. **Delegation** — dispatches to the injected controllers, which are
 *      provider-agnostic (platform adapters live in the input-provider
 *      package and are composed through the DI container).
 *
 * All input frames are fire-and-forget: handlers never send replies, which
 * keeps the input path at the lowest possible latency.
 */
import {
  isDragButton,
  isMediaKey,
  isMouseButton,
  KeyboardController,
  MouseController,
} from "@kbm-remote/input-provider";
import { FrameContext, FrameRouter, type GatewaySession } from "@kbm-remote/network";
import { FrameType, type FrameEnvelope } from "@kbm-remote/protocol";

export const MOUSE_PERMISSION = "mouse";
export const KEYBOARD_PERMISSION = "keyboard";
export const MEDIA_PERMISSION = "media";

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
    private readonly keyboard: KeyboardController | null = null,
  ) {}

  /** Registers every mouse and keyboard frame handler with the gateway's frame router. */
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
    router.register(FrameType.KeyPress, async (f, ctx) => {
      this.handleKeyPress(f, ctx);
      return { ok: true };
    });
    router.register(FrameType.KeyHold, async (f, ctx) => {
      this.handleKeyHold(f, ctx);
      return { ok: true };
    });
    router.register(FrameType.KeyRelease, async (f, ctx) => {
      this.handleKeyRelease(f, ctx);
      return { ok: true };
    });
    router.register(FrameType.TextInput, async (f, ctx) => {
      this.handleTextInput(f, ctx);
      return { ok: true };
    });
    router.register(FrameType.Shortcut, async (f, ctx) => {
      this.handleShortcut(f, ctx);
      return { ok: true };
    });
    router.register(FrameType.MediaKey, async (f, ctx) => {
      this.handleMediaKey(f, ctx);
      return { ok: true };
    });
  }

  // ── permission gate ──────────────────────────────────────────────────

  private hasMousePermission(ctx: FrameContext): boolean {
    return this.checkPermission(ctx, MOUSE_PERMISSION);
  }

  private hasKeyboardPermission(ctx: FrameContext): boolean {
    return this.checkPermission(ctx, KEYBOARD_PERMISSION);
  }

  private hasMediaPermission(ctx: FrameContext): boolean {
    return this.checkPermission(ctx, MEDIA_PERMISSION);
  }

  /** Shared permission gate used by both input subsystems. */
  private checkPermission(ctx: FrameContext, scope: string): boolean {
    if (!ctx.authenticated || !ctx.sessionId) {
      ctx.close(4005, "not authenticated");
      this.log.warn(`${scope} frame rejected: unauthenticated session`);
      return false;
    }
    const session = this.sessionLookup(ctx.sessionId);
    const granted = session?.permissions?.includes(scope) ?? false;
    if (!granted) {
      ctx.close(4005, `missing ${scope} permission`);
      this.log.warn(`${scope} frame rejected: session lacks '${scope}' permission`);
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

  private handleKeyPress(f: FrameEnvelope, ctx: FrameContext): void {
    if (!this.hasKeyboardPermission(ctx)) return;
    const kb = this.keyboard;
    if (!kb) {
      this.log.warn("keyboard frame rejected: keyboard controller unavailable");
      return;
    }
    const p = f.p as Record<string, unknown>;
    if (!p || !isKeyArray(p.keys)) {
      this.log.warn("keyboard press rejected: keys must be a non-empty array");
      return;
    }
    void kb.pressKeys({ keys: p.keys }).catch((err: unknown) => {
      this.log.warn(`keyboard press failed: ${(err as Error).message}`);
    });
  }

  private handleKeyHold(f: FrameEnvelope, ctx: FrameContext): void {
    if (!this.hasKeyboardPermission(ctx)) return;
    const kb = this.keyboard;
    if (!kb) {
      this.log.warn("keyboard frame rejected: keyboard controller unavailable");
      return;
    }
    const p = f.p as Record<string, unknown>;
    if (!p || typeof p.key !== "string") {
      this.log.warn("keyboard hold rejected: key must be a string");
      return;
    }
    void (async (): Promise<void> => {
      await kb.holdKey({
        key: p.key,
        repeatStartMs:
          typeof p.repeatStartMs === "number" ? (p.repeatStartMs as number) : undefined,
        repeatIntervalMs:
          typeof p.repeatIntervalMs === "number"
            ? (p.repeatIntervalMs as number)
            : undefined,
      });
    })().catch((err: unknown) => {
      this.log.warn(`keyboard hold failed: ${(err as Error).message}`);
    });
  }

  private handleKeyRelease(f: FrameEnvelope, ctx: FrameContext): void {
    if (!this.hasKeyboardPermission(ctx)) return;
    const kb = this.keyboard;
    if (!kb) {
      this.log.warn("keyboard frame rejected: keyboard controller unavailable");
      return;
    }
    const p = f.p as Record<string, unknown>;
    if (!p || typeof p.key !== "string") {
      this.log.warn("keyboard release rejected: key must be a string");
      return;
    }
    void kb.releaseKey({ key: p.key }).catch((err: unknown) => {
      this.log.warn(`keyboard release failed: ${(err as Error).message}`);
    });
  }

  private handleTextInput(f: FrameEnvelope, ctx: FrameContext): void {
    if (!this.hasKeyboardPermission(ctx)) return;
    const kb = this.keyboard;
    if (!kb) {
      this.log.warn("keyboard frame rejected: keyboard controller unavailable");
      return;
    }
    const p = f.p as Record<string, unknown>;
    if (!p || typeof p.text !== "string") {
      this.log.warn("textInput rejected: text must be a string");
      return;
    }
    void kb.typeText({ text: p.text }).catch((err: unknown) => {
      this.log.warn(`textInput failed: ${(err as Error).message}`);
    });
  }

  private handleShortcut(f: FrameEnvelope, ctx: FrameContext): void {
    if (!this.hasKeyboardPermission(ctx)) return;
    const kb = this.keyboard;
    if (!kb) {
      this.log.warn("keyboard frame rejected: keyboard controller unavailable");
      return;
    }
    const p = f.p as Record<string, unknown>;
    if (!p || !isKeyArray(p.keys)) {
      this.log.warn("shortcut rejected: keys must be a non-empty array");
      return;
    }
    void kb
      .shortcut({
        keys: p.keys,
        holdMs: typeof p.holdMs === "number" ? (p.holdMs as number) : undefined,
      })
      .catch((err: unknown) => {
        this.log.warn(`shortcut failed: ${(err as Error).message}`);
      });
  }

  private handleMediaKey(f: FrameEnvelope, ctx: FrameContext): void {
    if (!this.hasMediaPermission(ctx)) return;
    const kb = this.keyboard;
    if (!kb) {
      this.log.warn("media key frame rejected: keyboard controller unavailable");
      return;
    }
    const p = f.p as Record<string, unknown>;
    if (!p || typeof p.key !== "string" || !isMediaKey(p.key)) {
      this.log.warn("media key rejected: invalid key identifier");
      return;
    }
    void kb.mediaKey({ key: p.key }).catch((err: unknown) => {
      this.log.warn(`media key failed: ${(err as Error).message}`);
    });
  }
}

function isClickAction(value: unknown): value is "click" | "dblclick" | "down" | "up" {
  return value === "click" || value === "dblclick" || value === "down" || value === "up";
}

// ── keyboard helpers ───────────────────────────────────────────────────

function isKeyArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && value.length > 0;
}
