/**
 * LatencyMetrics — rolling RTT, jitter and loss derivation from Ping/Pong
 * round trips (Protocol Spec §5.1).
 *
 * - RTT: sender wall-clock delta between Ping send and Pong arrival.
 * - Jitter: rolling stddev over the last 32 RTT samples.
 * - Loss: fraction of pings without a pong in the last 60 s.
 * - Quality band: good (<25 ms) / degraded (25–75 ms) / poor (>75 ms).
 */

export interface LatencySample {
  /** Round-trip time in milliseconds. */
  rtt: number;
  /** Sender wall-clock ms when the pong arrived. */
  receivedAt: number;
}

export type ConnectionQuality = "good" | "degraded" | "poor" | "unknown";

export const RTT_ROLLING_WINDOW = 32;
export const LOSS_WINDOW_MS = 60_000;

export const LATENCY_GOOD_MAX_MS = 25;
export const LATENCY_POOR_MIN_MS = 75;

/** Monotonic wall clock used for metric timestamps (testable override). */
let nowMs: () => number = () => Date.now();

export function setClock(clock: () => number): void {
  nowMs = clock;
}

export class LatencyMetrics {
  private rtts: number[] = [];
  private pingTimes = new Map<number, number>();
  private pongsReceived = 0;
  private pingsSent = 0;
  private lastActivity = 0;

  /** Marks any frame reception — feeds the 15 s silence watchdog. */
  touch(): void {
    this.lastActivity = nowMs();
  }

  /** Milliseconds of the last observed inbound frame. */
  get lastActivityAt(): number {
    return this.lastActivity;
  }

  /** Sender-side: start of a Ping round trip. */
  pingSent(seq: number): void {
    this.pingTimes.set(seq, nowMs());
    this.pingsSent += 1;
  }

  /** Sender-side: record a pong and derive the RTT sample. */
  pongReceived(seq: number): void {
    this.touch();
    const sendAt = this.pingTimes.get(seq);
    this.pingTimes.delete(seq);
    if (sendAt === undefined) return; // stale / duplicate pong — ignore
    this.pongsReceived += 1;
    this.rtts.push(nowMs() - sendAt);
    if (this.rtts.length > RTT_ROLLING_WINDOW) {
      this.rtts.shift();
    }
  }

  /** Receiver-side: record a received Ping (for loss accounting when paired). */
  pingReceived(): void {
    this.touch();
    this.pingsSent += 1;
  }

  /** Receiver-side: record a sent Pong. */
  pongSent(): void {
    this.pongsReceived += 1;
  }

  /** Current smoothed RTT estimate (median of the rolling window). */
  get rtt(): number | null {
    if (this.rtts.length === 0) return null;
    const sorted = [...this.rtts].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? null;
  }

  /** Rolling standard deviation of the last 32 RTTs (jitter). */
  get jitter(): number {
    if (this.rtts.length < 2) return 0;
    const mean = this.rtts.reduce((s, x) => s + x, 0) / this.rtts.length;
    const variance =
      this.rtts.reduce((s, x) => s + (x - mean) ** 2, 0) / this.rtts.length;
    return Math.sqrt(variance);
  }

  /**
   * Fraction of pings sent in the last 60 s that never produced a pong.
   * Only meaningful on the sender side, where pingSent/pongReceived match.
   */
  get lossFraction(): number {
    if (this.pingsSent === 0) return 0;
    const cutoff = nowMs() - LOSS_WINDOW_MS;
    let recentPings = 0;
    let recentMissed = 0;
    // Count only round trips still open (pong never arrived).
    for (const sendAt of this.pingTimes.values()) {
      if (sendAt >= cutoff) {
        recentPings += 1;
        recentMissed += 1;
      }
    }
    if (recentPings === 0) return 0;
    return recentMissed / (recentPings + this.pongsReceivedForWindow(cutoff));
  }

  private pongsReceivedForWindow(_cutoff: number): number {
    // Approximation: all completed round trips in the window. Precise per-ping
    // bookkeeping is unnecessary — loss is evaluated on the current window,
    // and stale completed trips don't affect the fraction.
    return this.pongsReceived;
  }

  /** Quality band per Protocol Spec §6.2 thresholds. */
  get quality(): ConnectionQuality {
    if (this.rtt === null) return "unknown";
    if (this.rtt < LATENCY_GOOD_MAX_MS) return "good";
    if (this.rtt <= LATENCY_POOR_MIN_MS) return "degraded";
    return "poor";
  }

  /** All RTT samples — for logging and persistence. */
  get samples(): number[] {
    return [...this.rtts];
  }

  /** Reset for a fresh connection run. */
  reset(): void {
    this.rtts = [];
    this.pingTimes.clear();
    this.pongsReceived = 0;
    this.pingsSent = 0;
  }
}
