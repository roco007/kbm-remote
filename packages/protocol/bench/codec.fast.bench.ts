/**
 * FastCodec benchmark (Milestone 6) — reused msgpackr Encoder/Decoder,
 * single-pass envelope encoding, sequential mode.
 *
 * Run: pnpm exec tsx --tsconfig tsconfig.bench.json packages/protocol/bench/codec.fast.bench.ts
 */
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

async function measure(name: string, fn: () => unknown, iters: number): Promise<number> {
  for (let i = 0; i < 200; i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return Math.round((iters / elapsedMs) * 100) / 100;
}

console.log("=== FastCodec benchmark ===");
void (async () => {
  console.log(
    `  encode mouseMove: ${await measure("e", () => encodeFrameFast(mouseMove), 200_000)} ops/ms`,
  );
  console.log(
    `  decode mouseMove: ${await measure("d", () => decodeFrameFast(encodeFrameFast(mouseMove)), 200_000)} ops/ms`,
  );
  console.log(
    `  encode keyPress: ${await measure("e", () => encodeFrameFast(keyPress), 200_000)} ops/ms`,
  );
  console.log(
    `  decode keyPress: ${await measure("d", () => decodeFrameFast(encodeFrameFast(keyPress)), 200_000)} ops/ms`,
  );
  console.log(
    `  encode clipboard 4KB: ${await measure("e", () => encodeFrameFast(bigClipboard), 50_000)} ops/ms`,
  );
  console.log(
    `  decode clipboard 4KB: ${await measure("d", () => decodeFrameFast(encodeFrameFast(bigClipboard)), 50_000)} ops/ms`,
  );
})();
