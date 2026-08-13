/**
 * Side-by-side codec comparison (Milestone 6) — runs the baseline codec and
 * FastCodec on identical payloads in one process, so run-to-run variance
 * cancels out. Used for the before/after table in
 * docs/Optimization-Benchmarks-M6.md.
 *
 * Run: pnpm exec tsx --tsconfig tsconfig.bench.json packages/protocol/bench/codec.compare.bench.ts
 */
import { decodeFrame, encodeFrame } from "../src/codec";
import { decodeFrameFast, encodeFrameFast } from "../src/codec/FastCodec";
import type { FrameEnvelope } from "../src/types";

let mid = 0;
function frame(type: number, payload: Record<string, unknown>): FrameEnvelope {
  return { t: type, mid: ++mid, v: 1, ts: Date.now(), p: payload };
}

const mouseMove = frame(0x11, { dx: 12, dy: -3, screen: 0 });
const keyPress = frame(0x20, { key: "a", pressed: true });
const bigClipboard = frame(0x30, {
  content: "x".repeat(4000),
  mimeType: "text/plain",
});

async function measure(fn: () => unknown, iters: number): Promise<number> {
  for (let i = 0; i < 200; i++) await fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) await fn();
  return Math.round((iters / (Number(process.hrtime.bigint() - t0) / 1e6)) * 100) / 100;
}

async function runAll(): Promise<void> {
  await compare(
    "encode mouseMove",
    () => encodeFrame(mouseMove),
    () => encodeFrameFast(mouseMove),
    200_000,
  );
  await compare(
    "decode mouseMove",
    async () => decodeFrame(await encodeFrame(mouseMove)),
    () => decodeFrameFast(encodeFrameFast(mouseMove)),
    200_000,
  );
  await compare(
    "encode keyPress",
    () => encodeFrame(keyPress),
    () => encodeFrameFast(keyPress),
    200_000,
  );
  await compare(
    "decode keyPress",
    async () => decodeFrame(await encodeFrame(keyPress)),
    () => decodeFrameFast(encodeFrameFast(keyPress)),
    200_000,
  );
  await compare(
    "encode clipboard 4KB",
    () => encodeFrame(bigClipboard),
    () => encodeFrameFast(bigClipboard),
    50_000,
  );
  await compare(
    "decode clipboard 4KB",
    async () => decodeFrame(await encodeFrame(bigClipboard)),
    () => decodeFrameFast(encodeFrameFast(bigClipboard)),
    50_000,
  );
}

void runAll();

async function compare(
  name: string,
  baseFn: () => unknown,
  fastFn: () => unknown,
  iters: number,
): Promise<void> {
  const base = await measure(baseFn, iters);
  const fast = await measure(fastFn, iters);
  const ratio = Math.round((fast / base) * 10) / 10;
  console.log(
    `  ${name.padEnd(24)} baseline ${String(base).padStart(8)} ops/ms  fast ${String(fast).padStart(8)} ops/ms  (${ratio}x)`,
  );
}

console.log("=== Codec comparison: baseline vs FastCodec (same payloads) ===");
