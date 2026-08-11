import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";

import {
  COMPRESSION_THRESHOLD_BYTES,
  CodecError,
  encodeFrame,
  setCompressor,
} from "../src/codec";
import { validateEnvelope } from "../src/validation";

describe("@kbm-remote/protocol codec", () => {
  it("round trips a small frame uncompressed (c omitted)", async () => {
    const frame = {
      t: 0x01,
      mid: 0,
      v: 1,
      ts: 1_700_000_000_000,
      p: { x: 100, y: 200 },
    };
    const bytes = await encodeFrame(frame);
    const decoded = msgpackDecode(bytes) as Record<string, unknown>;

    expect(decoded.c).toBeUndefined();
    expect(decoded.t).toBe(0x01);
    expect(decoded.p).toEqual({ x: 100, y: 200 });
  });

  it("compresses payloads larger than the 256-byte threshold and marks c: 1", async () => {
    const big = Array.from({ length: 512 }, (_, i) => i % 256);
    const frame = {
      t: 0x0e,
      mid: 0,
      v: 1,
      ts: 0,
      p: { data: big },
    };
    const bytes = await encodeFrame(frame);
    const outer = msgpackDecode(bytes) as Record<string, unknown>;

    expect(outer.c).toBe(1);
    const outerPayload = outer.p as { __raw: number[] };
    expect(outerPayload.__raw.length).toBeLessThan(big.length);
    expect(outerPayload.__raw.length).toBeGreaterThan(0);
  });

  it("leaves payloads at/below the threshold uncompressed", async () => {
    // The threshold is measured on the raw msgpack encoding of `p`, including
    // its structural overhead. Pick a payload whose encoded size lands exactly
    // at the 256-byte boundary.
    const target = COMPRESSION_THRESHOLD_BYTES;
    let size = 0;
    let n = 0;
    for (;;) {
      const candidate = new Array(n).fill(1);
      const encoded = msgpackEncode({ data: candidate });
      if (encoded.length > target) break;
      size = encoded.length;
      n += 1;
    }
    const frame = {
      t: 0x0e,
      mid: 0,
      v: 1,
      ts: 0,
      p: { data: new Array(n - 1).fill(1) },
    };
    const bytes = await encodeFrame(frame);
    const outer = msgpackDecode(bytes) as Record<string, unknown>;
    expect(size).toBeLessThanOrEqual(target);
    expect(outer.c).toBeUndefined();
  });

  it("decompresses via an injected compressor backend", async () => {
    try {
      const frame = { t: 0x0e, mid: 1, v: 1, ts: 0, p: { data: new Array(512).fill(7) } };
      const bytes = await encodeFrame(frame);
      // Swap to an identity compressor so the injected inflate path is exercised.
      setCompressor({
        deflate: (raw) => raw,
        inflate: () => new Uint8Array(msgpackEncode({ data: new Array(512).fill(7) })),
      });
      const decoded = await import("../src/codec/index.js").then(({ decodeFrame }) =>
        decodeFrame(bytes),
      );
      expect(decoded.wasCompressed).toBe(true);
      expect((decoded.frame.p as { data: number[] }).data).toHaveLength(512);
    } finally {
      // Restore the Node zlib backend used by every other test.
      setCompressor(createNodeCompressor());
    }
  });

  it("rejects garbage bytes with a CodecError", async () => {
    const { decodeFrame } = await import("../src/codec/index.js");
    await expect(decodeFrame(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).rejects.toThrow(
      CodecError,
    );
  });

  it("rejects msgpack payloads that are not envelopes", async () => {
    const { decodeFrame } = await import("../src/codec/index.js");
    const bytes = msgpackEncode({ foo: "bar" });
    await expect(decodeFrame(new Uint8Array(bytes))).rejects.toThrow(CodecError);
  });

  it("reports wasCompressed for compressed frames only", async () => {
    const { decodeFrame } = await import("../src/codec/index.js");
    const small = await encodeFrame({ t: 0x01, mid: 0, v: 1, ts: 0, p: { a: 1 } });
    const big = await encodeFrame({
      t: 0x0e,
      mid: 0,
      v: 1,
      ts: 0,
      p: { b: new Array(512).fill(9) },
    });

    expect((await decodeFrame(small)).wasCompressed).toBe(false);
    expect((await decodeFrame(big)).wasCompressed).toBe(true);
  });
});

describe("validateEnvelope", () => {
  const base = { t: 0x01, mid: 0, v: 1, ts: 0, p: {} };

  it("accepts a well-formed envelope", () => {
    expect(() => validateEnvelope(base)).not.toThrow();
  });

  it("rejects envelopes with unknown type discriminators", () => {
    expect(() => validateEnvelope({ ...base, t: 0xff })).toThrow(
      /unknown type discriminator/,
    );
  });

  it("rejects non-integer or negative mids", () => {
    expect(() => validateEnvelope({ ...base, mid: 1.5 })).toThrow(/mid/);
    expect(() => validateEnvelope({ ...base, mid: -1 })).toThrow(/mid/);
  });

  it("rejects missing or malformed fields", () => {
    expect(() => validateEnvelope({ t: 0x01 })).toThrow();
    expect(() => validateEnvelope({ ...base, v: 1.5 })).toThrow(/v must be/);
    expect(() => validateEnvelope({ ...base, ts: "now" })).toThrow(/ts must be/);
    expect(() => validateEnvelope({ ...base, p: "payload" })).toThrow(/p must be a map/);
  });

  it("accepts the optional c flag only as 0 or 1", () => {
    expect(() => validateEnvelope({ ...base, c: 1 })).not.toThrow();
    expect(() => validateEnvelope({ ...base, c: 2 })).toThrow(/c must be 0 or 1/);
  });

  it("rejects null and non-object inputs", () => {
    expect(() => validateEnvelope(null)).toThrow(/not an object/);
    expect(() => validateEnvelope([])).toThrow();
  });
});

function createNodeCompressor() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const zlib: typeof import("node:zlib") = require("node:zlib");
  return {
    deflate: (raw: Uint8Array) => new Uint8Array(zlib.deflateRawSync(Buffer.from(raw))),
    inflate: (compressed: Uint8Array) =>
      new Uint8Array(zlib.inflateRawSync(Buffer.from(compressed))),
  };
}
