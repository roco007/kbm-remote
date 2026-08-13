/**
 * Codec: MessagePack serialization with the §2.5 compression threshold.
 *
 * - Frames ≤ 256 bytes raw fly uncompressed (`c` field omitted / 0).
 * - Frames > 256 bytes raw are DEFLATE-compressed and marked `c: 1`.
 * - WebSocket permessage-deflate is deliberately NOT used (§2.5).
 *
 * Implements Protocol Specification §2 (binary frames, `kbmremote.v1+msgpack`
 * subprotocol) and §2.5 (compression).
 */

import { decode, encode } from "@msgpack/msgpack";

import type { FrameEnvelope } from "../types";

/** Raw-byte threshold above which a frame payload is compressed. */
export const COMPRESSION_THRESHOLD_BYTES = 256;

/** Protocol major version carried in every envelope. */
export const PROTOCOL_MAJOR_VERSION = 1;

export interface DecodeResult {
  frame: FrameEnvelope;
  wasCompressed: boolean;
}

export class CodecError extends Error {
  constructor(reason: string) {
    super(`Codec error: ${reason}`);
    this.name = "CodecError";
  }
}

/**
 * Raw DEFLATE (no zlib header) — matches Protocol Spec §2.5, which requires
 * plain DEFLATE so senders/receivers can interoperate with any RFC 1951
 * implementation. Node ships zlib; React Native pulls the same algorithm via
 * pako-style shims at the app layer.
 */
export interface Compressor {
  deflate(raw: Uint8Array): Uint8Array;
  inflate(compressed: Uint8Array): Uint8Array;
}

export let compressor: Compressor = createNodeCompressor();

/** Replace the DEFLATE backend (e.g., pako on React Native). */
export function setCompressor(next: Compressor): void {
  compressor = next;
}

function createNodeCompressor(): Compressor {
  // Lazy require keeps the package importable where zlib is unavailable.
  let zlib: typeof import("node:zlib") | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    zlib = require("node:zlib");
  } catch {
    zlib = undefined;
  }
  return {
    deflate(raw) {
      if (!zlib) throw new CodecError("no DEFLATE backend available");
      return new Uint8Array(zlib.deflateRawSync(Buffer.from(raw)));
    },
    inflate(compressed) {
      if (!zlib) throw new CodecError("no DEFLATE backend available");
      return new Uint8Array(zlib.inflateRawSync(Buffer.from(compressed)));
    },
  };
}

function isEnvelopeLike(value: unknown): value is FrameEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.t === "number" &&
    Number.isInteger(f.t) &&
    typeof f.mid === "number" &&
    Number.isInteger(f.mid) &&
    f.mid >= 0 &&
    typeof f.v === "number" &&
    typeof f.ts === "number" &&
    typeof f.p === "object" &&
    f.p !== null &&
    (f.c === undefined || f.c === 0 || f.c === 1)
  );
}

/** Encode a frame envelope to a WebSocket-ready binary buffer. */
export async function encodeFrame(frame: FrameEnvelope): Promise<Uint8Array> {
  let payload: Uint8Array = new Uint8Array(encode(frame.p));

  let compressed = false;
  if (payload.length > COMPRESSION_THRESHOLD_BYTES) {
    payload = compressor.deflate(payload);
    compressed = true;
  }

  const envelope: FrameEnvelope = {
    t: frame.t,
    mid: frame.mid,
    v: frame.v,
    ts: frame.ts,
    p: compressed ? { __raw: Array.from(payload) } : frame.p,
    ...(compressed ? { c: 1 } : {}),
  };

  return encode(envelope) as Uint8Array;
}

/** Decode a WebSocket binary buffer back into a frame envelope. */
export async function decodeFrame(buffer: Uint8Array): Promise<DecodeResult> {
  let raw: unknown;
  try {
    raw = decode(buffer);
  } catch {
    throw new CodecError("malformed MessagePack payload");
  }

  if (!isEnvelopeLike(raw)) {
    throw new CodecError("payload is not a valid frame envelope");
  }

  const wasCompressed = raw.c === 1;
  let payload = raw.p;

  if (wasCompressed) {
    const packed = payload.__raw;
    if (!Array.isArray(packed) || packed.length === 0) {
      throw new CodecError("compressed frame missing payload bytes");
    }
    try {
      payload = decode(compressor.inflate(new Uint8Array(packed))) as Record<
        string,
        unknown
      >;
    } catch {
      throw new CodecError("compressed payload failed to decompress");
    }
  }

  return { frame: { ...raw, p: payload }, wasCompressed };
}
