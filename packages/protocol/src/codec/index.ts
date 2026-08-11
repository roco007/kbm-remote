/**
 * Codec: MessagePack serialization with the §2.5 compression threshold.
 *
 * - Frames ≤ 256 bytes raw fly uncompressed (`c` field omitted / 0).
 * - Frames > 256 bytes raw are DEFLATE-compressed and marked `c: 1`.
 * - WebSocket permessage-deflate is deliberately NOT used (§2.5).
 *
 * Implementation arrives in the M2 milestone; only the public surface is
 * declared here so both apps can import without breaking.
 */

import type { FrameEnvelope } from "../types";

/** Raw-byte threshold above which a frame payload is compressed. */
export const COMPRESSION_THRESHOLD_BYTES = 256;

export interface DecodeResult {
  frame: FrameEnvelope;
  wasCompressed: boolean;
}

/** Encode a frame envelope to a WebSocket-ready binary buffer. TODO (M2). */
export async function encodeFrame(_frame: FrameEnvelope): Promise<Uint8Array> {
  throw new Error("encodeFrame not implemented yet (M2 milestone)");
}

/** Decode a WebSocket binary buffer back into a frame envelope. TODO (M2). */
export async function decodeFrame(_buffer: Uint8Array): Promise<DecodeResult> {
  throw new Error("decodeFrame not implemented yet (M2 milestone)");
}
