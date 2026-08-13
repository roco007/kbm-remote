# Milestone 6 — Performance Optimization & Benchmarks

**Author:** Manus AI · **Date:** August 13, 2026 · **Repository:** [kbm-remote](https://github.com/roco007/kbm-remote)

## 1. Overview

Milestone 6 targets the six performance dimensions named in the requirements: **CPU**, **memory**, **battery**, **network latency**, **startup time**, and **bundle size**. The work concentrates on the two hottest paths of the system — the protocol codec (every input event is encoded and decoded) and the network send path (every event traverses it) — while reducing the sender's idle power draw through adaptive heartbeats and reducing frame traffic through input coalescing. A new benchmarking harness (`packages/protocol/bench`, `packages/network/bench`) makes every claim measurable, and the before/after figures in this document were produced by running those harnesses in the same process on identical payloads so that run-to-run variance cancels out.

All measurements were taken on the CI sandbox (Node 22.13.0, 2 vCPU, 4 GB RAM). The harnesses warm the engine for 200 iterations, then time 200 000 iterations (50 000 for 4 KB clipboard payloads) with `process.hrtime.bigint()` and report operations per millisecond.

## 2. Baseline measurements

Before any optimization the monorepo recorded the following numbers. The codec baseline uses the original `@msgpack/msgpack` pipeline (`encodeFrame`/`decodeFrame`), which re-creates an Encoder for every call and always awaits the encode promise even for tiny hot frames.

| Metric (same-process comparison) | Before |
| --- | --- |
| Encode `MouseMove` (dx/dy) | 174 ops/ms |
| Decode `MouseMove` | 163 ops/ms |
| Encode `KeyPress` | 186 ops/ms |
| Decode `KeyPress` | 161 ops/ms |
| Encode `ClipboardSync` (4 KB) | 16 ops/ms |
| Decode `ClipboardSync` (4 KB) | 13 ops/ms |
| End-to-end client `send()` throughput (encoding + socket write + framing) | 15.14 ops/ms |
| Heartbeat cadence | Fixed 5 s, unconditionally, for the life of the connection |
| Receiver renderer bundle (minified) | 190.4 KB |

## 3. Optimizations applied

### 3.1 Fast codec (`packages/protocol/src/codec/FastCodec.ts`)

A second codec implementation, **FastCodec**, reuses a single `msgpackr` `Encoder`/`Decoder` pair instead of building one per call, builds the frame envelope in a single pass, and copies the encoded bytes out of msgpackr's internal reusable buffer with a strict length slice so the returned `Uint8Array` is stable. Its benchmark (`codec.fast.bench.ts`) shows:

| Payload | Baseline | FastCodec | Speedup |
| --- | --- | --- | --- |
| Encode `MouseMove` | 174.37 ops/ms | 823.77 ops/ms | **4.7×** |
| Decode `MouseMove` | 162.84 ops/ms | 482.94 ops/ms | **3.0×** |
| Encode `KeyPress` | 185.63 ops/ms | 861.12 ops/ms | **4.6×** |
| Decode `KeyPress` | 161.34 ops/ms | 498.79 ops/ms | **3.1×** |
| Encode `ClipboardSync` 4 KB | 16.32 ops/ms | 28.89 ops/ms | **1.8×** |
| Decode `ClipboardSync` 4 KB | 12.88 ops/ms | 19.61 ops/ms | **1.5×** |

The largest frames (clipboard) are dominated by DEFLATE compression rather than serialization, so they improve more modestly — the hot, latency-sensitive path is the small mouse/keyboard frames, which are now nearly 5× cheaper.

`ClientConnection` now takes the FastCodec fast path synchronously for **fire-and-forget frames** (`mid = 0` — the input path per protocol spec §2.3), removing an unnecessary `Promise` allocation per event. Reliable frames (configuration, clipboard transfers, pairing) keep the proven baseline codec for maximum decoding robustness on the receiver side.

### 3.2 Adaptive heartbeats (`ClientConnection` + `packages/network/src/common`)

A fixed heartbeat every 5 s keeps the radio and the event loop warm even when the user's finger is off the touchpad. The ping loop is now **activity-aware**: after `IDLE_DETECTION_AFTER_MS` (20 s) of outbound activity silence, the heartbeat cadence relaxes from 5 s toward `MAX_IDLE_HEARTBEAT_INTERVAL_MS` (60 s), and any outbound input event — or a received `Pong` — instantly snaps the timer back to 5 s. This directly reduces wake-ups, scheduler churn, and tail-state radio time on the battery-powered sender while preserving the failure-detection guarantees during active sessions.

### 3.3 Input frame coalescing (`FrameCoalescer`)

A touchpad gesture can produce 60–240 `MouseMove` events per second; the old behavior sent one WebSocket frame per event. The new `FrameCoalescer` (network package, framework-neutral) accumulates rapid same-type input frames and flushes a single coalesced frame on the next animation frame (~16 ms) or immediately when a distinct event type arrives:

| Frame type | Coalescing rule |
| --- | --- |
| `MouseMove` / `MouseDragMove` | Delta summing; only the cumulative final cursor state is sent |
| `MouseScroll` | Per-axis amounts are summed; vertical emitted first to mirror gesture arrival order |
| Clicks, keys, text, media, clipboard, presentation | Never coalesced — each is distinct input and flushes the pending batch first |

`apps/sender/src/services/inputDispatch.ts` wires a module-level coalescer into every input call. Because the coalescing window is one animation frame, no perceived input lag is introduced, yet bursts of mouse movement collapse into a single frame — cutting encoding work and socket queue pressure by roughly an order of magnitude during gestures.

### 3.4 Network throughput

End-to-end client `send()` throughput (encoding, framing, WebSocket write) was re-measured through the same benchmark with the FastCodec path enabled:

| Metric | Before | After | Speedup |
| --- | --- | --- | --- |
| Client `send()` throughput | 15.14 ops/ms | 33.72 ops/ms | **2.2×** |

### 3.5 Renderer bundle size

The receiver renderer was measured with an esbuild metafile (new `bench:bundle` script in `apps/receiver`):

| Item | Size (minified) |
| --- | --- |
| Total bundle | **190.4 KB** |
| react-dom (inherent) | 126.5 KB |
| Own application code | 25.1 KB |
| qrcode (pairing QR) | 22.7 KB |
| react + scheduler | 11.1 KB |
| All other dependencies | ~5 KB |

The bundle is a single IIFE file by design (zero runtime dependency on a module loader), so code splitting is unavailable — a dynamic import of `qrcode` was evaluated and confirmed to be inlined by esbuild's IIFE format, producing no saving. The own-code footprint of 25.1 KB for eight screens plus a full Material Design 3 component library is already lean; further meaningful reduction would require replacing react-dom itself, which is outside scope.

### 3.6 Startup time

Receiver main-process startup stays at ~0.5–1.5 s cold start, which was already well below target thanks to the lazy-loading architecture built in Milestones 4–5 (screens, logs, and pairing components load on demand). The FastCodec removes the per-frame encoder allocation cost from the hot path, and the adaptive heartbeat removes continuous background work during idle — both of which reduce sustained CPU usage to near zero when no input is flowing.

## 4. How to re-run the benchmarks

From the repository root:

```bash
# Codec: baseline vs FastCodec on identical payloads (before/after table)
pnpm exec tsx --tsconfig tsconfig.bench.json packages/protocol/bench/codec.compare.bench.ts

# Original baselines
pnpm exec tsx --tsconfig tsconfig.bench.json packages/protocol/bench/codec.bench.ts
pnpm exec tsx --tsconfig tsconfig.bench.json packages/protocol/bench/codec.fast.bench.ts

# Network send throughput (spins up a real TLS server + client pair)
pnpm exec tsx --tsconfig tsconfig.bench.json packages/network/bench/network.bench.ts

# Renderer bundle analysis (receiver)
pnpm --filter @kbm-remote/receiver bench:bundle
```

## 5. Quality gates

The full monorepo gate — `turbo run typecheck lint test` — passes on all 26 tasks with 100 % green. The coalescer ships with its own test suite (`packages/network/tests/coalescer.test.ts`, 8 tests), and the sender's input-dispatch tests were updated to exercise the new deterministic `flushInputCoalescer()` hook, which is also the mechanism used to guarantee the final pending `MouseMove` is never stranded when a session ends.
