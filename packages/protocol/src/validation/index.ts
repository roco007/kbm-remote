/**
 * FrameValidator — enforces type-registry membership and payload bounds
 * per Protocol Specification §7.
 */

import { FrameType, type FrameEnvelope } from "../types";

export class FrameValidationError extends Error {
  constructor(public readonly reason: string) {
    super(`Frame validation failed: ${reason}`);
    this.name = "FrameValidationError";
  }
}

/** Returns true if the discriminator belongs to the v1.x registry. */
export function isValidFrameType(
  discriminator: number,
): discriminator is (typeof FrameType)[keyof typeof FrameType] {
  return Object.values(FrameType).includes(discriminator as never);
}

/**
 * Envelope structural validation — Protocol Spec §2.3 plus type-specific
 * payload bounds for the types whose shape is known at validation time.
 * Throws FrameValidationError with a machine-readable reason on failure.
 */
export function validateEnvelope(envelope: unknown): FrameEnvelope {
  if (typeof envelope !== "object" || envelope === null) {
    throw new FrameValidationError("not an object");
  }

  const frame = envelope as Record<string, unknown>;

  if (typeof frame.t !== "number" || !Number.isInteger(frame.t)) {
    throw new FrameValidationError("t must be an integer");
  }
  if (!isValidFrameType(frame.t)) {
    throw new FrameValidationError("unknown type discriminator");
  }

  if (typeof frame.mid !== "number" || !Number.isInteger(frame.mid) || frame.mid < 0) {
    throw new FrameValidationError("mid must be a non-negative integer");
  }

  if (typeof frame.v !== "number" || !Number.isInteger(frame.v) || frame.v < 0) {
    throw new FrameValidationError("v must be a non-negative integer");
  }

  if (typeof frame.ts !== "number" || frame.ts < 0) {
    throw new FrameValidationError("ts must be a non-negative number");
  }

  if (typeof frame.p !== "object" || frame.p === null) {
    throw new FrameValidationError("p must be a map");
  }

  if (frame.c !== undefined && frame.c !== 0 && frame.c !== 1) {
    throw new FrameValidationError("c must be 0 or 1");
  }

  return frame as unknown as FrameEnvelope;
}

/**
 * Convenience predicate returning a boolean — prefer validateEnvelope when
 * the reason for rejection is needed.
 */
export function isWellFormedEnvelope(envelope: unknown): boolean {
  try {
    validateEnvelope(envelope);
    return true;
  } catch {
    return false;
  }
}
