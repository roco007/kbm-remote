/**
 * ClientConnection — WSS client for the sender app (Protocol Spec §3–§6).
 *
 * Responsibilities:
 * - Open a WebSocket with the `kbmremote.v1+msgpack` subprotocol; the host
 *   app supplies the TLS socket (cert-pin validated, §3.1).
 * - Run the Hello → HelloAck handshake, capturing sessionId for token
 *   re-authentication on reconnect (§5.4).
 * - Ping every 5 s; derive RTT, jitter, loss (§5.1); 3 missed pongs →
 *   reconnect (§6.4).
 * - Reliable-frame outbox: mid > 0 frames wait for Ack, retry with
 *   jittered exponential backoff, 4 attempts, mid never reused (§5.2).
 * - Exponential-backoff reconnection (500 ms → 10 s cap) with state events.
 *
 * Platform-agnostic: `WebSocket` is injected (Node `ws` in tests/Electron,
 * React Native's built-in WebSocket in production), so the package stays
 * framework-free.
 */

import { FrameType, type FrameEnvelope, encodeFrameFast } from "@kbm-remote/protocol";

import {
  CLOSE_CODES,
  IDLE_DETECTION_AFTER_MS,
  IDLE_HEARTBEAT_INTERVAL_MS,
  MAX_ACK_ATTEMPTS,
  MAX_IDLE_HEARTBEAT_INTERVAL_MS,
  PING_INTERVAL_MS,
  PROTOCOL_MAJOR_VERSION,
  retryDelay,
  reconnectDelay,
  SUBPROTOCOL,
} from "../common";
import { Logger } from "../logging";
import { LatencyMetrics, type ConnectionQuality } from "../monitoring";

export type ClientState =
  "idle" | "connecting" | "connected" | "authenticated" | "reconnecting" | "disconnected";

export interface ClientOptions {
  /** `wss://host:port` of the receiver. */
  url: string;
  /** Factory producing a WebSocket implementation (Node ws / RN native). */
  socketFactory: (url: string, protocols: string[]) => ClientSocket;
  /** Human device label sent in Hello (§4.2). */
  clientName: string;
  /** `android` | `ios` — sent in Hello (§4.2). */
  clientOs: "android" | "ios";
  /** Capabilities to advertise (§2.7). */
  capabilities?: string[];
  /** Stored sessionId + token for token-based re-authentication (§5.4). */
  resume?: { sessionId: string; sessionToken: string };
  /**
   * Security-audit §3.1 — certificate pinning. For platforms whose socket
   * stack exposes the peer certificate (Node `tlsSocket.authorized` flow),
   * the host app resolves the PEM and passes it here; a null/false return
   * aborts the connection with a user-visible impersonation warning.
   */
  checkServerCertificate?: (peerCertificatePem: string) => boolean;
  /** Override clocks/timers in tests. */
  clock?: () => number;
  timerFactory?: {
    setInterval(handler: () => void, ms: number): { clear(): void };
    setTimeout(handler: () => void, ms: number): { clear(): void };
  };
}

/** Minimal socket interface — satisfied by both `ws` and React Native. */
export interface ClientSocket {
  readyState: number;
  binaryType: string;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev?: { message?: string }) => void) | null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null;
  send(data: ArrayBuffer | Uint8Array | string): void;
  close(code?: number, reason?: string): void;
}

export interface PendingFrame {
  frame: FrameEnvelope;
  attempts: number;
  timer?: unknown;
  resolve: (result: FrameResult) => void;
}

export type FrameResult = { ok: true } | { ok: false; reason: string };

export interface ClientEvents {
  stateChange?: (state: ClientState) => void;
  helloAck?: (payload: Record<string, unknown>) => void;
  authOk?: (payload: Record<string, unknown>) => void;
  authFailed?: (payload: Record<string, unknown>) => void;
  /** Security-audit §3.1 — fired when the peer certificate fails the pin. */
  certPinFailed?: (peerCertificatePem: string) => void;
  message?: (frame: FrameEnvelope) => void;
  reconnecting?: (attempt: number) => void;
  /** RTT/jitter/quality updated — feed the UX latency chip. */
  metrics?: (rtt: number | null, jitter: number, quality: ConnectionQuality) => void;
}

const READY_OPEN = 1;

export class ClientConnection {
  private socket: ClientSocket | null = null;
  private state: ClientState = "idle";
  /** Security-audit §3.1 — peer certificate PEM for pinning (set by host). */
  peerCertificate: string | null = null;
  /** One-time auth challenge from HelloAck, echoed in Authenticate (§3.4). */
  private authChallenge: string | null = null;
  private midCounter = 1;
  private pingSeq = 0;
  private missedPongs = 0;
  private reconnectAttempts = 0;
  private reconnecting = false;
  private disposed = false;
  private pending = new Map<number, PendingFrame>();
  private pingTimer?: { clear(): void };
  private reconnectTimer?: { clear(): void };

  // ── Adaptive heartbeat (Milestone 6) ──────────────────────────────────
  /** Current ping cadence; grows while idle, snaps back on activity. */
  private heartbeatIntervalMs = PING_INTERVAL_MS;
  /** Wall-clock of the last outbound input frame or received pong. */
  private lastOutboundActivityAt = 0;

  private get heartbeatInterval(): number {
    const idleFor = this.clock() - this.lastOutboundActivityAt;
    if (idleFor < IDLE_DETECTION_AFTER_MS) return PING_INTERVAL_MS;
    const steps = Math.min(
      Math.floor((idleFor - IDLE_DETECTION_AFTER_MS) / IDLE_HEARTBEAT_INTERVAL_MS) + 1,
      Math.ceil(
        (MAX_IDLE_HEARTBEAT_INTERVAL_MS - PING_INTERVAL_MS) / IDLE_HEARTBEAT_INTERVAL_MS,
      ),
    );
    return Math.min(
      PING_INTERVAL_MS + steps * IDLE_HEARTBEAT_INTERVAL_MS,
      MAX_IDLE_HEARTBEAT_INTERVAL_MS,
    );
  }

  readonly metrics = new LatencyMetrics();
  private readonly log = new Logger("client");
  private readonly clock: () => number;
  private readonly timers: NonNullable<ClientOptions["timerFactory"]>;

  /** Handlers the host app wires in. */
  events: ClientEvents = {};

  /** Session identity assigned by the receiver's HelloAck. */
  sessionId: string | null = null;

  /**
   * Re-target the peer URL (e.g. after manual IP entry replaces a stale
   * stored address). The next `connect()` or reconnect attempt uses the
   * new value.
   */
  setUrl(url: string): void {
    (this.options as { url: string }).url = url;
  }

  constructor(private readonly options: ClientOptions) {
    this.clock = options.clock ?? Date.now;
    this.timers = options.timerFactory ?? {
      setInterval: (handler, ms) => {
        const id = setInterval(handler, ms);
        return { clear: () => clearInterval(id) };
      },
      setTimeout: (handler, ms) => {
        const id = setTimeout(handler, ms);
        return { clear: () => clearTimeout(id) };
      },
    };
  }

  get connectionState(): ClientState {
    return this.state;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.disposed) throw new Error("ClientConnection disposed");
    this.setState("connecting");
    this.reconnectAttempts = 0;
    await this.openSocket();
  }

  /** Tear down permanently — no further reconnects. */
  dispose(): void {
    this.disposed = true;
    this.clearPingTimer();
    this.clearReconnectTimer();
    this.failAllPending("disposed");
    this.socket?.close(CLOSE_CODES.Normal, "client disposed");
    this.socket = null;
    this.setState("disconnected");
  }

  // ── Authenticate (§5.2) + challenge echo (§3.4) ─────────────────────

  /**
   * Run the certificate pin check provided by the host app. The peer PEM is
   * not available from the plain WebSocket contract — the host's socket
   * factory stores the last-seen certificate on `this.peerCertificate` while
   * constructing the socket. On first connection the QR-code pin wins;
   * afterwards the previously-stored pin is reused (TOFU, §3.1).
   */
  private async runCertPinCheck(): Promise<void> {
    const peerPem = this.peerCertificate;
    if (!peerPem || !this.options.checkServerCertificate) {
      this.log.info("socket open (no cert available for pinning)");
      this.reconnectAttempts = 0;
      void this.sendHello();
      return;
    }
    if (!this.options.checkServerCertificate(peerPem)) {
      this.log.error("peer certificate fails pin check — impersonation suspected");
      this.events.certPinFailed?.(peerPem);
      this.setState("disconnected");
      this.socket?.close(CLOSE_CODES.NotAuthenticated, "certPinMismatch");
      return;
    }
    this.log.info("socket open, peer certificate pinned");
    this.reconnectAttempts = 0;
    void this.sendHello();
  }

  /**
   * Transmit the Authenticate frame with the one-time challenge echo.
   * The challenge is consumed on this call — a second Authenticate on the
   * same session can never replay it.
   */
  private sendAuthenticate(credentials: {
    sessionId: string;
    sessionToken: string;
  }): void {
    const challenge = this.authChallenge;
    this.authChallenge = null;
    this.send({
      t: FrameType.Authenticate,
      ts: this.clock(),
      p: {
        sessionId: credentials.sessionId,
        sessionToken: credentials.sessionToken,
        challenge: challenge ?? "",
      },
    });
  }

  // ── Sending ──────────────────────────────────────────────────────────

  /**
   * Fire-and-forget send (input events, ping): mid = 0, never retried.
   */
  send(frame: Omit<FrameEnvelope, "mid" | "v">): void {
    this.sendFrame({ ...frame, mid: 0, v: PROTOCOL_MAJOR_VERSION });
  }

  /**
   * Reliable send: waits for Ack, retries per §5.2, resolves false after
   * exhausting attempts so the UX can show "send failed — retry?".
   */
  sendReliable(frame: Omit<FrameEnvelope, "mid" | "v">): Promise<FrameResult> {
    const mid = this.midCounter++;
    const pending: PendingFrame = {
      frame: { ...frame, mid, v: PROTOCOL_MAJOR_VERSION },
      attempts: 0,
      resolve: () => undefined,
    };
    const result = new Promise<FrameResult>((resolve) => {
      pending.resolve = resolve;
    });
    this.pending.set(mid, pending);
    this.sendFrame(pending.frame);
    this.scheduleRetry(pending);
    return result;
  }

  /**
   * Disconnect gracefully (§4.12): send Disconnect, wait for echo, close.
   */
  disconnectGracefully(): void {
    this.send({
      t: FrameType.Disconnect,
      ts: this.clock(),
      p: { reason: "userDisconnect", graceful: true },
    });
    // Give the receiver up to 2 s to echo before we close the socket.
    this.timers.setTimeout(() => {
      this.socket?.close(CLOSE_CODES.Normal, "graceful disconnect");
    }, 2000);
  }

  // ── Socket handling ──────────────────────────────────────────────────

  private async openSocket(): Promise<void> {
    const socket = this.options.socketFactory(this.options.url, [SUBPROTOCOL]);
    this.socket = socket;
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      // Security-audit §3.1 — pin gate: the socket factory resolved the TLS
      // socket for us; if a cert check is registered, run it BEFORE any
      // protocol frames flow. A pin mismatch closes the socket with a
      // user-visible impersonation warning and aborts the handshake.
      if (this.options.checkServerCertificate) {
        void this.runCertPinCheck();
        return;
      }
      this.log.info("socket open");
      this.reconnectAttempts = 0;
      void this.sendHello();
    };

    socket.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        this.log.warn("ignoring text frame from server");
        return;
      }
      void this.handleMessage(ev.data as ArrayBuffer);
    };

    socket.onerror = (ev) => {
      this.log.error("socket error", { message: ev?.message ?? "unknown" });
    };

    socket.onclose = (ev) => {
      const code = ev?.code ?? CLOSE_CODES.NotAuthenticated;
      this.onSocketClose(code);
    };
  }

  private async sendHello(): Promise<void> {
    this.metrics.reset();
    const hello: FrameEnvelope = {
      t: FrameType.Hello,
      mid: 0,
      v: PROTOCOL_MAJOR_VERSION,
      ts: this.clock(),
      p: {
        protoVersion: "1.0",
        clientName: this.options.clientName,
        clientOs: this.options.clientOs,
        capabilities: this.options.capabilities ?? [],
        clientTs: this.clock(),
        ...(this.options.resume
          ? { resumeSessionId: this.options.resume.sessionId }
          : {}),
      },
    };
    this.sendFrame(hello);
    // Auth window starts on Hello (§3.5) — the receiver enforces it; if we
    // hear nothing for 30 s, reconnect.
    this.timers.setTimeout(() => {
      if (this.state === "connecting") {
        this.log.warn("auth window elapsed without HelloAck — reconnecting");
        void this.sendHello();
      }
    }, 30000);
  }

  /** Security-audit §3.1 — store the peer PEM so the pin gate can use it. */
  setPeerCertificate(pem: string): void {
    this.peerCertificate = pem;
  }

  private async handleMessage(raw: ArrayBuffer): Promise<void> {
    this.metrics.touch();
    let frame: FrameEnvelope;
    try {
      const { decodeFrame } = await import("@kbm-remote/protocol");
      ({ frame } = await decodeFrame(new Uint8Array(raw)));
    } catch (error) {
      this.log.error("failed to decode frame", { error: String(error) });
      return;
    }

    switch (frame.t) {
      case FrameType.HelloAck: {
        this.sessionId = frame.p.sessionId as string;
        // Security-audit §3.4 — capture the one-time challenge and send
        // Authenticate with the echo immediately; the nonce may only ever
        // be used once, so it is cleared after the reply.
        const challenge = frame.p.challenge as string | undefined;
        if (typeof challenge === "string") this.authChallenge = challenge;
        this.setState("connected");
        this.events.helloAck?.(frame.p);
        this.startPingLoop();
        if (frame.p.authRequired === false) {
          this.setState("authenticated");
        }
        // Authenticate (§5.2): stored token + mandatory challenge echo.
        if (this.options.resume) {
          this.sendAuthenticate(this.options.resume);
        }
        break;
      }

      case FrameType.AuthOk:
        this.setState("authenticated");
        this.events.authOk?.(frame.p);
        break;

      case FrameType.AuthFailed:
        this.events.authFailed?.(frame.p);
        // Authentication never degrades into a retry loop (§5.3) — fail to UX.
        this.failAllPending("authFailed");
        this.socket?.close(CLOSE_CODES.NotAuthenticated, "auth failed");
        break;

      case FrameType.Pong: {
        const seq = frame.p.seq as number | null;
        if (typeof seq === "number") {
          this.metrics.pongReceived(seq);
          this.missedPongs = 0;
          // Milestone 6: an inbound pong counts as round-trip activity —
          // keeps the heartbeat fast if traffic flows in either direction.
          this.lastOutboundActivityAt = this.clock();
        }
        this.emitMetrics();
        break;
      }

      case FrameType.Ack: {
        const mid = frame.p.mid as number;
        const pending = this.pending.get(mid);
        if (pending) {
          this.pending.delete(mid);
          pending.timer && (pending.timer as { clear(): void }).clear();
          pending.resolve({ ok: true });
        }
        break;
      }

      case FrameType.Nack: {
        const mid = frame.p.mid as number;
        const pending = this.pending.get(mid);
        if (pending) {
          this.pending.delete(mid);
          pending.timer && (pending.timer as { clear(): void }).clear();
          // Terminal refusals (permissionDenied, malformed) must not retry.
          if (frame.p.reason === "permissionDenied" || frame.p.reason === "malformed") {
            pending.resolve({ ok: false, reason: frame.p.reason as string });
          } else {
            // Transient refusal — retry like a lost ack, within budget.
            this.scheduleRetry(pending, true);
          }
        }
        break;
      }

      default:
        this.events.message?.(frame);
        break;
    }
  }

  private onSocketClose(code: number): void {
    this.clearPingTimer();
    this.socket = null;

    const fatal =
      code === CLOSE_CODES.Revoked || code === CLOSE_CODES.IncompatibleVersion;
    if (fatal || this.disposed) {
      this.setState("disconnected");
      this.failAllPending(code === CLOSE_CODES.Revoked ? "revoked" : "fatal");
      return;
    }

    // Reconnect backoff per §5.4.
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnecting) return;
    this.reconnecting = true;
    this.setState("reconnecting");
    this.events.reconnecting?.(this.reconnectAttempts);
    this.clearReconnectTimer();

    const delay = reconnectDelay(this.reconnectAttempts);
    this.log.info("reconnecting", {
      attempt: this.reconnectAttempts,
      delayMs: Math.round(delay),
    });

    this.reconnectTimer = this.timers.setTimeout(async () => {
      this.reconnecting = false;
      this.reconnectAttempts += 1;
      try {
        await this.openSocket();
      } catch (error) {
        this.log.error("reconnect failed", { error: String(error) });
        this.scheduleReconnect();
      }
    }, delay);
  }

  // ── Heartbeat loop ───────────────────────────────────────────────────

  private startPingLoop(): void {
    this.clearPingTimer();
    this.heartbeatIntervalMs = PING_INTERVAL_MS;
    this.pingTimer = this.timers.setInterval(() => this.tickPing(), PING_INTERVAL_MS);
  }

  /**
   * Ping tick — §5.1, with the adaptive interval of Milestone 6. While no
   * input frame has flowed for `IDLE_DETECTION_AFTER_MS`, the cadence backs
   * off by `IDLE_HEARTBEAT_INTERVAL_MS` per round up to the cap; any
   * outbound `send()` reschedules the timer at the fast cadence.
   */
  private tickPing(): void {
    const interval = this.heartbeatInterval;
    if (interval !== this.heartbeatIntervalMs) {
      this.heartbeatIntervalMs = interval;
      this.clearPingTimer();
      this.pingTimer = this.timers.setInterval(() => this.tickPing(), interval);
    }
    const seq = ++this.pingSeq;
    this.metrics.pingSent(seq);
    this.send({
      t: FrameType.Ping,
      ts: this.clock(),
      p: { seq, clientTs: this.clock() },
    });
    this.missedPongs += 1;
    if (this.missedPongs > 3) {
      this.log.warn("missed pong threshold — reconnecting");
      this.socket?.close(CLOSE_CODES.NotAuthenticated, "heartbeat failure");
    }
  }

  private clearPingTimer(): void {
    this.pingTimer?.clear();
    this.pingTimer = undefined;
  }

  private clearReconnectTimer(): void {
    this.reconnectTimer?.clear();
    this.reconnectTimer = undefined;
    this.reconnecting = false;
  }

  // ── Internals ────────────────────────────────────────────────────────

  private sendFrame(frame: FrameEnvelope): void {
    if (!this.socket || this.socket.readyState !== READY_OPEN) {
      this.log.warn("dropping frame — socket not open", { type: frame.t });
      return;
    }
    // Milestone 6: fire-and-forget frames (mid = 0) encode synchronously on
    // the reused FastCodec instance — no per-send promise allocation and no
    // fresh Encoder/Decoder per frame (the baseline codec pays both). This
    // is the hot path for every mouse move and key press.
    if (frame.mid === 0) {
      try {
        // Milestone 6: synchronous fast path — no per-send promise, reused
        // msgpackr Encoder/Decoder in encodeFrameFast.
        this.lastOutboundActivityAt = this.clock();
        this.socket.send(encodeFrameFast(frame));
      } catch (error) {
        this.log.error("failed to encode frame", { error: String(error) });
      }
      return;
    }
    import("@kbm-remote/protocol")
      .then(({ encodeFrame }) => encodeFrame(frame))
      .then((bytes) => this.socket?.send(bytes))
      .catch((error) => {
        this.log.error("failed to encode frame", { error: String(error) });
      });
  }

  private scheduleRetry(pending: PendingFrame, fromNack = false): void {
    if (!fromNack) pending.attempts += 1;
    if (pending.attempts >= MAX_ACK_ATTEMPTS) {
      this.pending.delete(pending.frame.mid);
      pending.resolve({ ok: false, reason: "retryExhausted" });
      return;
    }
    const delay = retryDelay(pending.attempts);
    pending.timer = this.timers.setTimeout(() => {
      this.sendFrame(pending.frame);
      this.scheduleRetry(pending);
    }, delay);
  }

  private failAllPending(reason: string): void {
    for (const pending of this.pending.values()) {
      pending.timer && (pending.timer as { clear(): void }).clear();
      pending.resolve({ ok: false, reason });
    }
    this.pending.clear();
  }

  private setState(next: ClientState): void {
    if (this.state === next) return;
    this.state = next;
    this.events.stateChange?.(next);
  }

  private emitMetrics(): void {
    this.events.metrics?.(this.metrics.rtt, this.metrics.jitter, this.metrics.quality);
  }
}
