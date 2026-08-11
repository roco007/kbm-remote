import { describe, expect, it } from "vitest";

import {
  LATENCY_GOOD_MAX_MS,
  LATENCY_POOR_MIN_MS,
  LatencyMetrics,
  LOSS_WINDOW_MS,
  RTT_ROLLING_WINDOW,
  setClock,
} from "../src/monitoring";

/**
 * LatencyMetrics — derived from Protocol Spec §5.1.
 *
 * RTT = sender wall-clock delta Ping→Pong; jitter = rolling stddev over the
 * last 32 samples; loss = fraction of pings without a pong in the last 60 s.
 */
describe("LatencyMetrics", () => {
  it("starts with no RTT and unknown quality", () => {
    const m = new LatencyMetrics();
    expect(m.rtt).toBeNull();
    expect(m.jitter).toBe(0);
    expect(m.lossFraction).toBe(0);
    expect(m.quality).toBe("unknown");
  });

  it("derives RTT from matched ping/pong pairs", () => {
    let now = 1_000_000;
    setClock(() => now);
    try {
      const m = new LatencyMetrics();
      m.pingSent(1);
      now += 12;
      m.pongReceived(1);
      expect(m.rtt).toBe(12);
      expect(m.quality).toBe("good");

      m.pingSent(2);
      now += 60;
      m.pongReceived(2);
      expect(m.rtt).toBe(60); // median of [12, 60] → 60
      expect(m.quality).toBe("degraded");

      m.pingSent(3);
      now += 100;
      m.pongReceived(3);
      // Median of [12, 60, 100] is 60 → degraded (§6.2: poor only above 75 ms).
      expect(m.quality).toBe("degraded");
    } finally {
      setClock(() => Date.now());
    }
  });

  it("ignores stale or duplicate pongs", () => {
    const m = new LatencyMetrics();
    m.pingSent(1);
    m.pongReceived(1);
    m.pongReceived(1); // duplicate — ignored
    m.pongReceived(99); // unknown seq — ignored
    expect(m.samples).toEqual([expect.any(Number)]);
  });

  it("rolls the RTT window to the last 32 samples", () => {
    const m = new LatencyMetrics();
    for (let i = 0; i < 40; i += 1) {
      m.pingSent(i);
      m.pongReceived(i);
    }
    expect(m.samples).toHaveLength(RTT_ROLLING_WINDOW);
  });

  it("computes jitter as the stddev of the rolling window", () => {
    let now = 1_000_000;
    setClock(() => now);
    try {
      const m = new LatencyMetrics();
      const rtts = [10, 20, 30, 40];
      for (let i = 0; i < rtts.length; i += 1) {
        m.pingSent(i);
        now += rtts[i]!;
        m.pongReceived(i);
      }
      const mean = 25;
      const expected = Math.sqrt(
        rtts.reduce((s, x) => s + (x - mean) ** 2, 0) / rtts.length,
      );
      expect(m.jitter).toBeCloseTo(expected, 6);
    } finally {
      setClock(() => Date.now());
    }
  });

  it("starts at good after a single fast ping", () => {
    const m = new LatencyMetrics();
    m.pingSent(1);
    m.pongReceived(1);
    expect(m.quality).toBe("good");
  });

  it("reports loss as the fraction of unanswered pings in the last 60 s", () => {
    let now = 1_000_000;
    setClock(() => now);
    try {
      const m = new LatencyMetrics();
      // 4 pings, 2 pongs → 2 open round trips, 2 completed → 2 / (2 + 2).
      for (let i = 0; i < 4; i += 1) {
        m.pingSent(i);
        if (i % 2 === 0) m.pongReceived(i);
      }
      expect(m.lossFraction).toBe(0.5);

      // Pongs arriving after the 60 s window no longer count — loss window
      // is evaluated on the current wall clock only.
      now += LOSS_WINDOW_MS + 1;
      expect(m.lossFraction).toBe(0);
    } finally {
      setClock(() => Date.now());
    }
  });

  it("touches activity on every inbound frame for the watchdog", () => {
    let now = 5_000;
    setClock(() => now);
    try {
      const m = new LatencyMetrics();
      m.touch();
      expect(m.lastActivityAt).toBe(5_000);
      now += 100;
      m.pingReceived();
      expect(m.lastActivityAt).toBe(5_100);
    } finally {
      setClock(() => Date.now());
    }
  });

  it("resets to a clean state", () => {
    const m = new LatencyMetrics();
    m.pingSent(1);
    m.pongReceived(1);
    m.reset();
    expect(m.rtt).toBeNull();
    expect(m.samples).toHaveLength(0);
    expect(m.quality).toBe("unknown");
  });

  it("classifies a 100 ms median RTT as poor", () => {
    let now = 1_000_000;
    setClock(() => now);
    try {
      const m = new LatencyMetrics();
      for (let i = 0; i < 3; i += 1) {
        m.pingSent(i);
        now += 100;
        m.pongReceived(i);
      }
      expect(m.quality).toBe("poor");
    } finally {
      setClock(() => Date.now());
    }
  });

  // Sanity guard so thresholds never drift apart.
  it("keeps the quality bands ordered and disjoint", () => {
    expect(LATENCY_GOOD_MAX_MS).toBeLessThan(LATENCY_POOR_MIN_MS);
    expect(LOSS_WINDOW_MS).toBeGreaterThan(0);
  });
});
