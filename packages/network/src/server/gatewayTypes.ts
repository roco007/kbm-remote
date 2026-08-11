/**
 * Shared types for the WssGateway's handler contract.
 */

import type { NackReason } from "../common";

/**
 * Result of a per-type frame handler. `ok: false` triggers a Nack with the
 * given reason — handlers never close connections directly; the gateway owns
 * connection lifetime (Protocol Spec §6.1).
 */
export type HandlerResult = { ok: true } | { ok: false; reason: NackReason };

/**
 * Typed error a handler can throw to fail with a specific Nack reason.
 */
export class FrameHandlerError extends Error {
  constructor(public readonly result: HandlerResult) {
    super(result.ok ? "handler error" : `handler refused: ${result.reason}`);
    this.name = "FrameHandlerError";
  }
}
