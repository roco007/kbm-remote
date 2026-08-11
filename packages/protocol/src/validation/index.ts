/**
 * FrameValidator — enforces type-registry membership and payload bounds
 * per Protocol Specification §7.
 *
 * TODO (M2): implement payload bounds checks once the payload schemas
 * (types/*.ts) are populated.
 */

import { FrameType } from "../types";

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

/** Validate a parsed envelope's structural fields. TODO (M2): payload bounds. */
export function validateEnvelope(_envelope: unknown): boolean {
  throw new Error("validateEnvelope not implemented yet (M2 milestone)");
}
