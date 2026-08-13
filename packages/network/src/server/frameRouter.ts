/**
 * FrameRouter — typed dispatch of decoded frames to per-type handlers
 * (Protocol Spec §4).
 *
 * Responsibilities:
 * - Register exactly one handler per FrameType discriminator.
 * - Enforce the pre-authentication gate (§3.3): before a session is
 *   authenticated, only Hello/PairRequest/PairResponse/Authenticate flow.
 * - Emit Ack/Nack per frame class (§5.2) and translate failures into
 *   frame-level Nacks with machine-readable reasons (§6.1).
 */

import { FrameType, type FrameEnvelope } from "@kbm-remote/protocol";
import { FrameValidationError } from "@kbm-remote/protocol";

import { FrameHandlerError, type HandlerResult } from "./gatewayTypes";
import { isNackReason, type NackReason } from "../common";

export type FrameContext = {
  /** Per-connection identity assigned after Hello (session or transient id). */
  sessionId: string;
  /** True once AuthOk/PairApproved has completed for this connection. */
  authenticated: boolean;
  /**
   * The one-time auth challenge issued in HelloAck (§3.4). Authenticate MUST
   * echo this exact value in `p.challenge`; any mismatch or reuse fails auth.
   */
  challenge?: string;
  /**
   * Consume the challenge (marks it used) and return its value. Used exactly
   * once by a successful Authenticate; after that the challenge is blank and
   * any further Authenticate on the same connection fails.
   */
  consumeChallenge?: () => string;
  /** Write a frame back to the peer. */
  send: (frame: FrameEnvelope) => void;
  /** Close the connection with a reason code. */
  close: (code: number, reason: string) => void;
  /**
   * Promote the connection's identity from the transient fingerprint to the
   * stable sessionId assigned in HelloAck. Optional because only Hello/
   * pairing handlers need it; every other handler can ignore it.
   */
  setSessionId?: (sessionId: string) => void;
};

/** Set of types allowed before authentication completes. */
export const PRE_AUTH_TYPES = new Set<number>([
  FrameType.Hello,
  FrameType.PairRequest,
  FrameType.PairResponse,
  FrameType.Authenticate,
]);

/**
 * Outcome of running a frame through the router. `ack` marks frames the
 * handler processed successfully (and may already have sent an Ack for);
 * `nack` marks refused frames with a reason; `fatal` marks connection-ending
 * errors surfaced to the gateway.
 */
export type RouteOutcome =
  | { kind: "ack"; frame: FrameEnvelope }
  | { kind: "nack"; frame: FrameEnvelope; reason: NackReason }
  | { kind: "fatal"; frame: FrameEnvelope; code: number; reason: string };

export type FrameHandler<T extends FrameEnvelope = FrameEnvelope> = (
  frame: T,
  ctx: FrameContext,
) => Promise<HandlerResult>;

/** Successful handler result — payload details left to the app layer. */
export interface FrameHandlerSuccess {
  ok: true;
}

export function handlerSuccess(): FrameHandlerSuccess {
  return { ok: true };
}

export class FrameRouter {
  private readonly handlers = new Map<number, FrameHandler>();

  register(type: number, handler: FrameHandler): void {
    this.handlers.set(type, handler);
  }

  has(type: number): boolean {
    return this.handlers.has(type);
  }

  /**
   * Route one decoded frame. Never throws at the transport boundary — every
   * failure mode maps to an outcome the gateway can act on.
   */
  async route(frame: FrameEnvelope, ctx: FrameContext): Promise<RouteOutcome> {
    // ── Structural validation (§7) ──────────────────────────────────────
    if (typeof frame.p !== "object" || frame.p === null) {
      return { kind: "nack", frame, reason: "malformed" };
    }

    // ── Version gate (§2.7) ─────────────────────────────────────────────
    if (frame.v !== 1) {
      return {
        kind: "fatal",
        frame,
        code: 4004,
        reason: `unsupported protocol major version ${frame.v}`,
      };
    }

    // ── Pre-authentication gate (§3.3) ──────────────────────────────────
    if (!ctx.authenticated && !PRE_AUTH_TYPES.has(frame.t)) {
      return { kind: "nack", frame, reason: "notAuthenticated" };
    }

    const handler = this.handlers.get(frame.t);
    if (!handler) {
      return { kind: "nack", frame, reason: "unknownType" };
    }

    let result: HandlerResult;
    try {
      result = await handler(frame, ctx);
    } catch (error) {
      result =
        error instanceof FrameHandlerError
          ? error.result
          : { ok: false, reason: "malformed" };
    }

    if (result.ok) {
      return { kind: "ack", frame };
    }

    // Handler refusals become Nacks, never silent drops.
    const reason = isNackReason(result.reason) ? result.reason : "malformed";
    return { kind: "nack", frame, reason };
  }
}

// Re-export so apps can throw typed handler errors without importing internals.
export { FrameValidationError };
