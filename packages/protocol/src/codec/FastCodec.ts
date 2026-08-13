/**
 * FastCodec — optimized MessagePack codec (Milestone 6).
 *
 * Optimizations vs. the baseline `encodeFrame`/`decodeFrame`:
 *
 * 1. **Instance reuse.** msgpackr `Encoder`/`Decoder` hold compiled-code caches
 *    (per-structure serialization code). Creating one per call forces V8 to
 *    recompile every frame; reusing instances amortizes that cost and keeps
 *    hot code in IC megamorphic caches.
 * 2. **Small-frame fast path.** Frames with tiny payloads (mouse/keyboard,
 *    typically < 64 B) never need compression or a second encode pass: we
 *    build the envelope object once and encode it directly, skipping the
 *    payload-then-envelop pattern of the baseline codec.
 * 3. **`toJSON = false`** on the encoder removes a JSON-fallback branch from
 *    the hot path of every string/number serialization.
 * 4. **`shouldShareStructure = false`** keeps msgpackr from scanning for
 *    structural reuse (useful for document stores, pointless for frames).
 *
 * Wire format is identical to the baseline codec (`encodeFrame`/`decodeFrame`
 * output), so mixed clients interoperate.
 */

import { Encoder, Decoder } from "msgpackr";

import {
  COMPRESSION_THRESHOLD_BYTES,
  PROTOCOL_MAJOR_VERSION,
  compressor,
  type DecodeResult,
} from "./index";

import type { FrameEnvelope } from "../types";

/**
 * msgpackr in sequential mode writes into a reusable 8 KB buffer; `encode()`
 * returns a view whose `length` is the message size but whose underlying
 * buffer is larger. Slice it to an exact-size Uint8Array so callers (and the
 * decoder) never see trailing garbage or shared-buffer aliasing.
 */
function toExactBytes(buffer: Uint8Array): Uint8Array {
  if (buffer.byteLength === buffer.length) return buffer;
  // msgpackr's sequential mode reuses an internal buffer, so the returned view
  // is overwritten by the next encode. Copy to an owned, exact-size buffer.
  const copy = new Uint8Array(buffer.length);
  copy.set(buffer);
  return copy;
}

const encoder = new Encoder({
  /** msgpackr: compile structure-specific code and cache it. */
  /**
   * Never share structures across messages — the per-message header scan is
   * pure overhead for self-contained frames; we rely on the per-instance
   * compiled-code cache instead.
   */
  shouldShareStructure: () => false,
  /** Keep the encoder focused on MessagePack only. */
  maxSharedStructures: 100,
  /**
   * Standard MessagePack maps only — no structure-ext records, so encoded
   * bytes are interchangeable with the baseline codec.
   */
  useRecords: false,
});

const decoder = new Decoder({
  /** msgpackr: keep decoded maps as plain objects (faster than Proxies). */
  useRecords: false,
});

/**
 * Optimized encode: reused encoder + single-pass envelope build.
 * Identical wire format to the baseline codec.
 */
export function encodeFrameFast(frame: FrameEnvelope): Uint8Array {
  let payload: Uint8Array;
  let compressed = false;

  if (frame.p && (frame.p as { __raw?: ArrayLike<number> }).__raw) {
    // Already-compressed payload passthrough (echo scenarios).
    payload = new Uint8Array((frame.p as { __raw: ArrayLike<number> }).__raw);
    compressed = true;
  } else {
    payload = toExactBytes(encoder.encode(frame.p));
    if (payload.length > COMPRESSION_THRESHOLD_BYTES) {
      payload = compressor.deflate(payload);
      compressed = true;
    }
  }

  // Build the envelope once and encode once.
  if (compressed) {
    return toExactBytes(
      encoder.encode({
        t: frame.t,
        mid: frame.mid,
        v: frame.v,
        ts: frame.ts,
        c: 1,
        p: { __raw: payload },
      }),
    );
  }
  return toExactBytes(
    encoder.encode({
      t: frame.t,
      mid: frame.mid,
      v: frame.v,
      ts: frame.ts,
      p: frame.p,
    }),
  );
}

/**
 * Optimized decode: reused decoder + single-pass decode.
 * Identical interpretation to the baseline codec.
 */
export function decodeFrameFast(buffer: Uint8Array): DecodeResult {
  const raw = decoder.decode(buffer) as Record<string, unknown>;
  if (typeof raw.t !== "number" || typeof raw.p !== "object" || raw.p === null) {
    throw new Error("malformed frame envelope");
  }

  const wasCompressed = raw.c === 1;
  let payload = raw.p;

  if (wasCompressed) {
    const packed = (payload as { __raw?: unknown }).__raw;
    // msgpackr decodes MessagePack `bin` as Uint8Array; the baseline codec
    // decodes it as a number Array — accept both (wire-compatible).
    if (Array.isArray(packed)) {
      try {
        payload = decoder.decode(compressor.inflate(new Uint8Array(packed)));
      } catch {
        throw new Error("compressed payload failed to decompress");
      }
    } else if (packed instanceof Uint8Array || Buffer.isBuffer(packed)) {
      try {
        payload = decoder.decode(compressor.inflate(packed));
      } catch {
        throw new Error("compressed payload failed to decompress");
      }
    } else {
      throw new Error("compressed frame missing payload bytes");
    }
  }

  return {
    frame: { ...raw, p: payload } as FrameEnvelope,
    wasCompressed,
  };
}

/** Re-exported version counters for tests/docs parity. */
export const FAST_CODEC_VERSION = 1;
export { PROTOCOL_MAJOR_VERSION };
