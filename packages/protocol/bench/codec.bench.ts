import { bench, run } from "tinybench";

import { decodeFrame, encodeFrame } from "../src/codec";
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

const before = process.memoryUsage().heapUsed;

void (async () => {
  const benchResults: { name: string; opsPerMs: number }[] = [];

async function measure(
  name: string,
  fn: () => unknown,
  iters: number,
): Promise<number> {
  // Warm-up (async-friendly — awaits the first round).
  for (let i = 0; i < 200; i++) await fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) await fn();
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const opsPerMs = Math.round((iters / elapsedMs) * 100) / 100;
  benchResults.push({ name, opsPerMs });
  return opsPerMs;
}

await measure("encode mouseMove", () => encodeFrame(mouseMove), 200_000).then(() => undefined);
await measure(
  "decode mouseMove",
  async () => decodeFrame(await encodeFrame(mouseMove)),
  200_000,
);
await measure("encode keyPress", () => encodeFrame(keyPress), 200_000);
await measure(
  "decode keyPress",
  async () => decodeFrame(await encodeFrame(keyPress)),
  200_000,
);
await measure("encode clipboard 4KB", () => encodeFrame(bigClipboard), 50_000);
await measure(
  "decode clipboard 4KB",
  async () => decodeFrame(await encodeFrame(bigClipboard)),
  50_000,
);

const after = process.memoryUsage().heapUsed;
console.log("=== Codec benchmark (before optimization) ===");
for (const r of benchResults) console.log(`  ${r.name}: ${r.opsPerMs} ops/ms`);
console.log(`  memory delta: ${Math.round((after - before) / 1024)} KB`);
  void bench; void run;
})();
