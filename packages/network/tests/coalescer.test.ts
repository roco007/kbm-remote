import { FrameType } from "@kbm-remote/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FrameCoalescer } from "../src/client/FrameCoalescer";

describe("FrameCoalescer", () => {
  let sent: ReturnType<FrameCoalescer["sendFrame"] extends never ? never : () => unknown>;
  let frames: Array<{ t: number; p: Record<string, unknown> }>;

  beforeEach(() => {
    frames = [];
    sent = vi.fn((frame) => frames.push(frame as never));
  });

  it("coalesces rapid mouseMove frames into one summed frame", () => {
    const c = new FrameCoalescer(sent as never);
    c.sendFrame({ t: FrameType.MouseMove, ts: 0, p: { dx: 1, dy: 2 } });
    c.sendFrame({ t: FrameType.MouseMove, ts: 0, p: { dx: 3, dy: 4 } });
    c.sendFrame({ t: FrameType.MouseMove, ts: 0, p: { dx: -2, dy: 1 } });
    c.dispose();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.p).toEqual({ dx: 2, dy: 7 });
  });

  it("sums mouseDragMove by absolute position (last wins) and deltas", () => {
    const c = new FrameCoalescer(sent as never);
    c.sendFrame({ t: FrameType.MouseDragMove, ts: 0, p: { x: 100, y: 200 } });
    c.sendFrame({ t: FrameType.MouseDragMove, ts: 0, p: { x: 300, y: 400 } });
    c.dispose();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.p).toEqual({ x: 300, y: 400 });
  });

  it("splits horizontal and vertical scroll batches", () => {
    const c = new FrameCoalescer(sent as never);
    c.sendFrame({ t: FrameType.MouseScroll, ts: 0, p: { axis: "vertical", amount: 2 } });
    c.sendFrame({
      t: FrameType.MouseScroll,
      ts: 0,
      p: { axis: "horizontal", amount: 1 },
    });
    c.sendFrame({ t: FrameType.MouseScroll, ts: 0, p: { axis: "vertical", amount: 3 } });
    c.dispose();
    expect(frames).toHaveLength(2);
    const v = frames.find((f) => f.p.axis === "vertical");
    const h = frames.find((f) => f.p.axis === "horizontal");
    expect(v?.p.amount).toBe(5);
    expect(h?.p.amount).toBe(1);
  });

  it("never coalesces clicks/keys and flushes the pending batch first", () => {
    const c = new FrameCoalescer(sent as never);
    c.sendFrame({ t: FrameType.MouseMove, ts: 0, p: { dx: 1, dy: 1 } });
    c.sendFrame({
      t: FrameType.MouseClick,
      ts: 0,
      p: { button: "left", action: "click" },
    });
    c.sendFrame({ t: FrameType.MouseMove, ts: 0, p: { dx: 2, dy: 2 } });
    c.dispose();
    expect(frames).toHaveLength(3);
    expect(frames[1]!.t).toBe(FrameType.MouseClick);
  });

  it("flushes on dispose with nothing pending (no crash)", () => {
    const c = new FrameCoalescer(sent as never);
    expect(() => c.dispose()).not.toThrow();
  });
});
