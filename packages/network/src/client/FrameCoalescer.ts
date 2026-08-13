/**
 * FrameCoalescer — input frame batching (Milestone 6, §B.3).
 *
 * A touchpad gesture can produce 60–240 MouseMove events per second. Sending
 * one WebSocket frame per event wastes CPU on encoding, clobbers the socket
 * send queue, and burns radio tail state. Instead, rapid same-type input
 * frames are accumulated into a single coalesced frame that is flushed on
 * the next animation frame (~16 ms) or immediately when the event type
 * changes.
 *
 * Coalescing rules (lossless for semantics, lossy only for in-flight
 * intermediates that would never be perceived anyway):
 * - `MouseMove` / `MouseDragMove`: dx/dy deltas are summed; only the final
 *   cumulative cursor position is sent.
 * - `MouseScroll`: amounts per axis are summed.
 * - Button/keyboard events are never coalesced (each is distinct input) and
 *   flush the pending batch instantly.
 *
 * Network-neutral: it only requires a `ClientConnection`-like `send` sink.
 * On React Native the flush is driven by `requestAnimationFrame` when
 * available, falling back to a 16 ms microtask batch.
 */

import { FrameType, type FrameEnvelope } from "@kbm-remote/protocol";

type Sender = (frame: Omit<FrameEnvelope, "mid" | "v">) => void;

interface PendingBatch {
  type: number;
  dx: number;
  dy: number;
  amountX: number;
  amountY: number;
  x?: number;
  y?: number;
}

const COALESCEABLE = new Set<number>([
  FrameType.MouseMove,
  FrameType.MouseDragMove,
  FrameType.MouseScroll,
]);

const raf: ((cb: () => void) => unknown) | undefined = (() => {
  try {
    const fn = (
      globalThis as unknown as { requestAnimationFrame?: (cb: () => void) => unknown }
    ).requestAnimationFrame;
    if (typeof fn === "function") return fn.bind(globalThis);
  } catch {
    /* headless — fall through to the timer */
  }
  return undefined;
})();

export class FrameCoalescer {
  private pending: PendingBatch | null = null;
  private flushHandle: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly send: Sender) {}

  /** Queue a fire-and-forget input frame, coalescing where legal. */
  sendFrame(frame: Omit<FrameEnvelope, "mid" | "v">): void {
    if (this.disposed) return;

    if (COALESCEABLE.has(frame.t)) {
      this.accumulate(frame);
      if (!this.flushHandle) {
        // Flush on the next animation frame; fall back to a 16 ms timer in
        // headless environments (tests, Electron main-less contexts).
        if (raf) {
          raf(() => this.flush());
        } else {
          // Headless (tests, non-browser runtimes): flush on the next
          // microtask so coalescing still absorbs same-turn bursts without
          // a 16 ms wall-clock delay.
          queueMicrotask(() => this.flush());
        }
      }
      return;
    }

    // Distinct input event — flush any coalesced batch first so ordering is
    // preserved (move → click must never swap).
    this.flush();
    this.send(frame);
  }

  private accumulate(frame: Omit<FrameEnvelope, "mid" | "v">): void {
    if (this.pending && this.pending.type !== frame.t) {
      this.flush();
    }
    if (!this.pending) {
      this.pending = { type: frame.t, dx: 0, dy: 0, amountX: 0, amountY: 0 };
    }
    const p = frame.p as Record<string, unknown>;
    if (frame.t === FrameType.MouseScroll) {
      if (p.axis === "horizontal") this.pending.amountX += Number(p.amount ?? 0);
      else this.pending.amountY += Number(p.amount ?? 0);
    } else {
      this.pending.dx += Number(p.dx ?? 0);
      this.pending.dy += Number(p.dy ?? 0);
      if ("x" in p) this.pending.x = Number(p.x);
      if ("y" in p) this.pending.y = Number(p.y);
    }
  }

  private flush(): void {
    if (this.flushHandle) {
      clearTimeout(this.flushHandle);
      this.flushHandle = null;
    }
    const batch = this.pending;
    this.pending = null;
    if (!batch) return;

    if (batch.type === FrameType.MouseScroll) {
      // Vertical scrolls are emitted first — that mirrors the arrival order
      // of real touchpad/trackpad gestures and keeps receivers that map one
      // scroll wheel event to vertical-only simple to implement.
      if (batch.amountY !== 0)
        this.send({
          t: FrameType.MouseScroll,
          ts: Date.now(),
          p: { axis: "vertical", amount: batch.amountY },
        });
      if (batch.amountX !== 0)
        this.send({
          t: FrameType.MouseScroll,
          ts: Date.now(),
          p: { axis: "horizontal", amount: batch.amountX },
        });
      return;
    }

    const payload: Record<string, number> =
      batch.type === FrameType.MouseMove
        ? { dx: batch.dx, dy: batch.dy }
        : { x: batch.x ?? 0, y: batch.y ?? 0 };
    this.send({ t: batch.type, ts: Date.now(), p: payload });
  }

  /** Flush and stop accepting frames (dispose the connection). */
  dispose(): void {
    this.flush();
    this.disposed = true;
  }
}
