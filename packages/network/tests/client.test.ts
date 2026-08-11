import { FrameType } from "@kbm-remote/protocol";
import { encode, decode as msgpackDecode } from "@msgpack/msgpack";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClientConnection, type ClientSocket } from "../src/client";
import { CLOSE_CODES, PING_INTERVAL_MS, SUBPROTOCOL } from "../src/common";
import { setClock } from "../src/monitoring";

/**
 * ClientConnection — Protocol Spec §3–§6, exercised through a fake WebSocket
 * that mirrors the minimal `ws` / React Native socket interface.
 *
 * Fake timers fire eagerly: every `setTimeout` scheduled so far (and not
 * cleared) fires on each `tick()`, matching Node's wall-clock semantics as
 * long as tests advance in steps larger than the longest retry delay.
 */

interface IntervalEntry {
  handler: () => void;
  ms: number;
  cleared: boolean;
}

interface TimeoutEntry {
  handler: () => void;
  ms: number;
  cleared: boolean;
  dueAt: number;
  fired: boolean;
}

class FakeTimers {
  value = 0;
  readonly intervals: IntervalEntry[] = [];
  readonly timeouts: TimeoutEntry[] = [];

  now = () => this.value;

  setInterval(handler: () => void, ms: number): { clear(): void } {
    const entry: IntervalEntry = { handler, ms, cleared: false };
    this.intervals.push(entry);
    return {
      clear: () => {
        entry.cleared = true;
      },
    };
  }

  setTimeout(handler: () => void, ms: number): { clear(): void } {
    const entry: TimeoutEntry = {
      handler,
      ms,
      cleared: false,
      dueAt: this.value + ms,
      fired: false,
    };
    this.timeouts.push(entry);
    return {
      clear: () => {
        entry.cleared = true;
      },
    };
  }

  /** Advance the clock and fire every interval/timeout whose time has come. */
  tick(ms: number): void {
    this.value += ms;
    // Fire every uncleared interval exactly once this tick, then drain
    // timeouts (handlers may schedule more timeouts — keep draining).
    const intervalsToFire = this.intervals.filter((i) => !i.cleared);
    for (const entry of intervalsToFire) {
      entry.handler();
    }
    let fired = true;
    while (fired) {
      fired = false;
      for (const entry of this.timeouts) {
        if (!entry.cleared && !entry.fired && entry.dueAt <= this.value) {
          entry.fired = true;
          fired = true;
          entry.handler();
        }
      }
    }
  }
}

class FakeSocket implements ClientSocket {
  readyState = 1;
  binaryType = "";
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev?: { message?: string }) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  sent: Uint8Array[] = [];
  closed = false;
  closeCode: number | undefined;

  send(data: ArrayBuffer | Uint8Array | string): void {
    this.sent.push(
      data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer),
    );
  }

  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000 });
  }

  /** Deliver an inbound binary frame to the client. */
  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: ownBytes(encode(frame)) });
  }
}

function decode(bytes: Uint8Array): Record<string, unknown> {
  return msgpackDecode(ownBytes(bytes)) as Record<string, unknown>;
}

/**
 * Returns an ArrayBuffer that owns exactly `bytes.byteLength` bytes. msgpack
 * refuses pooled buffers that extend past the slice, so callers must pass
 * byte-offset-correct slices rather than raw `.buffer`.
 */
function ownBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

describe("ClientConnection", () => {
  let conn: ClientConnection;
  let socket: FakeSocket;
  let states: string[];
  let timers: FakeTimers;

  function makeConnection(
    options: Partial<{ resume: { sessionId: string; sessionToken: string } }> = {},
  ) {
    const conn2 = new ClientConnection({
      url: "wss://receiver.local:8443",
      socketFactory: (url, protocols) => {
        expect(url).toBe("wss://receiver.local:8443");
        expect(protocols).toEqual([SUBPROTOCOL]);
        socket = new FakeSocket();
        return socket;
      },
      clientName: "test-phone",
      clientOs: "android",
      clock: () => timers.value,
      timerFactory: timers,
      ...options,
    });
    conn2.events.stateChange = (s) => states.push(s);
    return conn2;
  }

  beforeEach(() => {
    timers = new FakeTimers();
    states = [];
    conn = makeConnection();
  });

  afterEach(() => {
    conn.dispose();
  });

  /** Full handshake helper: connect, simulate socket open, deliver HelloAck. */
  async function handshake(authRequired = true): Promise<void> {
    void conn.connect(); // returns before onopen fires
    socket.onopen!();
    // The connect chain (socket creation → sendHello) runs asynchronously,
    // and the inbound HelloAck handler is async too — settle microtasks
    // before delivering the ack.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    socket.receive({
      t: FrameType.HelloAck,
      mid: 0,
      v: 1,
      ts: 0,
      p: { sessionId: "aabbccdd11223344", serverVersion: "1.0", authRequired },
    });
    // Let async message handling settle.
    await new Promise((r) => setTimeout(r, 0));
  }

  it("enters connecting, receives HelloAck, and becomes connected", async () => {
    await handshake();

    expect(states).toEqual(["connecting", "connected"]);
    expect(socket.sent.length).toBe(1);
    const hello = decode(socket.sent[0]!) as { t: number; p: Record<string, unknown> };
    expect(hello.t).toBe(FrameType.Hello);
    expect(hello.p.clientName).toBe("test-phone");
    expect(hello.p.clientOs).toBe("android");
    expect(hello.p.resumeSessionId).toBeUndefined();

    expect(conn.sessionId).toBe("aabbccdd11223344");
    expect(timers.intervals.some((i) => i.ms === PING_INTERVAL_MS)).toBe(true);
  });

  it("includes the resume session id in Hello when re-authenticating", async () => {
    conn.dispose();
    conn = makeConnection({
      resume: { sessionId: "persist-sess", sessionToken: "secret" },
    });
    conn.events.stateChange = (s) => states.push(s);

    void conn.connect();
    socket.onopen!();
    // Wait for the async connect chain to send Hello.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const hello = decode(socket.sent[0]!) as { t: number; p: Record<string, unknown> };
    expect(hello.t).toBe(FrameType.Hello);
    expect(hello.p.resumeSessionId).toBe("persist-sess");
    expect(hello.p.clientName).toBe("test-phone");
  });

  it("marks the session authenticated immediately when authRequired is false", async () => {
    await handshake(false);
    expect(states).toEqual(["connecting", "connected", "authenticated"]);
  });

  it("sends Ping every 5 s and derives RTT from Pong", async () => {
    await handshake();
    // Settle the async HelloAck handler before driving the ping loop.
    await new Promise((r) => setTimeout(r, 0));
    const pingCountBefore = socket.sent.length;

    // Fix the metrics wall clock BEFORE the ping is sent so the
    // Ping→Pong RTT sample is deterministic. Anchor to the fake timer clock
    // so both ping and pong timestamps come from the same timeline.
    setClock(() => timers.value);
    try {
      timers.tick(PING_INTERVAL_MS);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(socket.sent.length).toBe(pingCountBefore + 1);
      const ping = socket.sent.find((b) => decode(b).t === FrameType.Ping);
      expect(ping).toBeTruthy();
      const pingFrame = decode(ping!) as { p: Record<string, unknown> };
      expect(typeof pingFrame.p.seq).toBe("number");

      timers.tick(12);
      socket.receive({
        t: FrameType.Pong,
        mid: 0,
        v: 1,
        ts: 0,
        p: { seq: pingFrame.p.seq as number },
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(conn.metrics.rtt).toBe(12);
      expect(conn.metrics.quality).toBe("good");
    } finally {
      setClock(() => Date.now());
    }
  });

  it("reconnects after the missed-pong threshold", async () => {
    await handshake();

    // Fire four ping cycles without a pong (> MAX_MISSED_PONGS = 3).
    for (let i = 0; i < 4; i += 1) {
      timers.tick(PING_INTERVAL_MS);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(states).toContain("reconnecting");
    expect(socket.closeCode).toBe(CLOSE_CODES.NotAuthenticated);
    // The reconnect attempt is scheduled with jittered backoff ≥ 0.
    expect(timers.timeouts.some((t) => !t.cleared && t.ms >= 0)).toBe(true);
  });

  it("acks reliable frames and resolves sendReliable with ok", async () => {
    await handshake();

    const result = conn.sendReliable({
      t: FrameType.ClipboardQuery,
      ts: 0,
      p: { id: "clip-1" },
    });
    // The frame goes through the async msgpack encoder — settle first.
    await new Promise((r) => setTimeout(r, 0));
    // First send carries mid=1, v=1.
    const sent = socket.sent.find((b) => decode(b).mid === 1);
    expect(sent).toBeTruthy();

    socket.receive({ t: FrameType.Ack, mid: 0, v: 1, ts: 0, p: { mid: 1 } });
    await expect(result).resolves.toEqual({ ok: true });
  });

  it("retries reliable frames until exhausted", async () => {
    await handshake();

    const result = conn.sendReliable({
      t: FrameType.ClipboardQuery,
      ts: 0,
      p: { id: "clip-2" },
    });

    // Retry chain: attempts 0..3 back off up to ~2.25 s each; keep ticking
    // until the promise resolves (max 4 attempts).
    let rounds = 0;
    while (rounds++ < 50) {
      timers.tick(4_000);
      try {
        await Promise.race([
          result,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 0),
          ),
        ]);
        break;
      } catch {
        // not yet resolved
      }
      if (timers.timeouts.every((t) => t.cleared || t.fired)) break;
    }
    await expect(result).resolves.toEqual({ ok: false, reason: "retryExhausted" });
  });

  it("fails pending sends on revoke close without reconnecting", async () => {
    await handshake();
    const result = conn.sendReliable({
      t: FrameType.ClipboardQuery,
      ts: 0,
      p: { id: "c" },
    });
    await new Promise((r) => setTimeout(r, 0));

    // Server revokes the session.
    socket.onclose!({ code: CLOSE_CODES.Revoked });
    await expect(result).resolves.toEqual({ ok: false, reason: "revoked" });
    expect(states[states.length - 1]).toBe("disconnected");
    // No reconnect scheduled — revoked is terminal.
    expect(states).not.toContain("reconnecting");
  });

  it("sends Disconnect and schedules a graceful close", async () => {
    await handshake();

    conn.disconnectGracefully();
    // Disconnect also encodes asynchronously.
    await new Promise((r) => setTimeout(r, 0));
    const disconnect = socket.sent.find((b) => decode(b).t === FrameType.Disconnect);
    expect(disconnect).toBeTruthy();

    // Graceful close is scheduled 2 s later.
    expect(timers.timeouts.some((t) => t.ms === 2000 && !t.cleared)).toBe(true);
  });

  it("fails every pending frame on dispose", async () => {
    await handshake();
    const result = conn.sendReliable({
      t: FrameType.ClipboardQuery,
      ts: 0,
      p: { id: "c" },
    });
    await new Promise((r) => setTimeout(r, 0));

    conn.dispose();
    await expect(result).resolves.toEqual({ ok: false, reason: "disposed" });
    expect(conn.connectionState).toBe("disconnected");
  });

  it("rejects operations after disposal", async () => {
    conn.dispose();
    await expect(conn.connect()).rejects.toThrow(/disposed/);
  });
});
