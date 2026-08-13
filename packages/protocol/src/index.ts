/**
 * @kbm-remote/protocol
 *
 * Single source of truth for the KBM Remote wire contract.
 * See docs/Protocol-Documentation.md for the full specification.
 *
 * Layout:
 *   types/       — message type discriminators, payload interfaces, envelope
 *   codec/       — MessagePack encode/decode + optional DEFLATE compression
 *   validation/  — frame validator (type registry membership, payload bounds)
 *
 * No application logic lives in this package; it is pure serialization
 * and validation only, so it can run on both Electron and React Native.
 */

export * from "./types";
export * from "./codec";
export * from "./codec/FastCodec";
export * from "./validation";
