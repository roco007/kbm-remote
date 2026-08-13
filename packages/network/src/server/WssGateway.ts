/**
 * WssGateway — receiver-side WebSocket gateway host.
 *
 * Runs inside the Electron main process's NestJS application context.
 * Responsibilities (Protocol Spec §3–§6):
 *
 * - Binary-only WebSocket server advertising `kbmremote.v1+msgpack`.
 * - Auth state machine: Hello → (Pair* | Authenticate) → AuthOk,
 *   30 s window, else close 4001.
 * - 15 s silence watchdog per connection (§3.5).
 * - Ping/Pong replies and latency WARN logging (§5.1, §6.2).
 * - Frame routing with Ack/Nack (§5.2, §6.1).
 * - Graceful drain with close 4006 (§6.3).
 *
 * The gateway is framework-agnostic at the socket level: NestJS's
 * WebSocketGateway wires this class as the message handler.
 */

import { randomBytes } from "node:crypto";

import { FrameType, type FrameEnvelope } from "@kbm-remote/protocol";

import {
  ACCEPTED_SUBPROTOCOLS,
  AUTH_TIMEOUT_MS,
  CLOSE_CODES,
  IP_AUTH_BAN_MS,
  IP_AUTH_BAN_THRESHOLD,
  IP_AUTH_FAILURE_WINDOW_MS,
  DISCONNECT_ECHO_WAIT_MS,
  MAX_CONNECTIONS_PER_IP,
  MAX_MISSED_PONGS,
  SILENCE_WATCHDOG_MS,
  SUBPROTOCOL,
} from "../common";
import { FrameRouter, type FrameContext, type RouteOutcome } from "./frameRouter";
import { Logger } from "../logging";
import { LatencyMetrics } from "../monitoring";

import type { AuthDecision, AuthStore } from "./authMiddleware";
import type { Server as TLSServer } from "node:tls";
import type { WebSocket } from "ws";

export interface WssGatewayOptions {
  /** Port the WSS server listens on (TLS provided by the host app). */
  port: number;
  auth: { store: AuthStore; authWindowMs?: number };
  /** Maximum accepted raw frame size before Nack(payloadTooLarge). */
  maxFrameBytes?: number;
}

export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024; // 16 MB (file chunks)

export interface GatewaySession extends AuthDecision {
  ws: WebSocket;
  metrics: LatencyMetrics;
  missedPongs: number;
  connectedAt: number;
  lastPongTs: number;
  /** One-time auth challenge echoed inside Authenticate (§3.4). */
  challenge: string;
  /** Per-session replay guard: reliable frame mids seen this connection. */
  seenMids: Set<number>;
}

export type GatewayState = "starting" | "listening" | "draining" | "stopped";

export class WssGateway {
  private readonly router = new FrameRouter();
  private readonly maxFrameBytes: number;
  private readonly log = new Logger("gateway");

  private server: TLSServer | null = null;
  private readonly sessions = new Map<WebSocket, GatewaySession>();
  private state: GatewayState = "starting";

  // ── Per-IP flood protection (security audit §3.3) ────────────────────
  /** Live connection count per remote address. */
  private readonly connectionsPerIp = new Map<string, number>();
  /** Auth-failure ban windows: ip -> expiry epoch ms. */
  private readonly ipAuthBans = new Map<string, number>();
  /** Auth failure sliding window: ip -> list of failure epoch ms. */
  private readonly ipAuthFailures = new Map<string, number[]>();

  constructor(private readonly options: WssGatewayOptions) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  }

  /** Requested listen port as configured by the host application. */
  get configuredPort(): number {
    return this.options.port;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Start the gateway. The host app supplies the TLS server (self-signed
   * receiver cert, §2.6); this class binds the WebSocket upgrade onto it.
   */
  async start(tlsServer: TLSServer): Promise<void> {
    this.server = tlsServer;
    // Deferred dynamic import keeps React Native bundles free of `ws`.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wsModule = await import("ws");
    // Node's tls.Server does NOT emit the 'upgrade' event the way net.Server
    // does, so the WebSocketServer is attached directly to the TLS socket.
    // Subprotocol negotiation (§2.1, §2.7) happens in verifyClient — a
    // non-101 response aborts the handshake with HTTP 400.
    const wss = new wsModule.WebSocketServer({
      server: tlsServer as unknown as import("node:http").Server,
      maxPayload: this.maxFrameBytes,
      // Subprotocol negotiation (§2.1, §2.7): reject upgrades without a
      // supported protocol so unsupported clients get a clean HTTP 400.
      verifyClient: (
        info: { req: import("node:http").IncomingMessage },
        done: (res: boolean, code?: number, name?: string) => void,
      ): void => {
        const header = info.req.headers["sec-websocket-protocol"] ?? "";
        const requested = header
          .split(",")
          .map((s) => s.trim())
          .filter((s): s is typeof SUBPROTOCOL =>
            ACCEPTED_SUBPROTOCOLS.includes(s as typeof SUBPROTOCOL),
          );
        if (requested.length === 0) {
          this.log.warn("rejected upgrade — no supported subprotocol", {
            header,
          });
          done(false, 400, "unsupported subprotocol");
          return;
        }
        done(true);
      },
    } as unknown as import("ws").ServerOptions);

    // The host app binds the TLS socket itself (it owns the port and the
    // certificate), so the gateway only wires the WebSocket upgrade onto it.
    this.wireServer(wss);
    this.state = "listening";
    this.log.info("gateway listening", {
      port: (tlsServer.address() as import("node:net").AddressInfo)?.port,
    });
  }

  /** Stop accepting connections; wait up to 2 s for in-flight Disconnect echoes. */
  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "draining";
    this.log.info("gateway draining — closing sessions");

    for (const [ws, session] of this.sessions) {
      this.sendTo(ws, {
        t: FrameType.Disconnect,
        mid: 0,
        v: 1,
        ts: Date.now(),
        p: { reason: "serverShutdown", graceful: true },
      });
      void session;
      this.scheduleClose(
        ws,
        CLOSE_CODES.ServerShutdown,
        "server shutting down",
        DISCONNECT_ECHO_WAIT_MS,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, DISCONNECT_ECHO_WAIT_MS));
    await this.destroyServer();
    this.state = "stopped";
    this.log.info("gateway stopped");
  }

  get gatewayState(): GatewayState {
    return this.state;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Actual bound address of the underlying TLS server once `start` has
   * resolved (the host app binds the socket, so this reflects its choice).
   */
  get address(): import("node:net").AddressInfo | null {
    return this.server?.address() as import("node:net").AddressInfo | null;
  }

  // ── Registration API for app-level handlers ──────────────────────────

  get frameRouter(): FrameRouter {
    return this.router;
  }

  // ── Upgrade & connection setup ───────────────────────────────────────

  private wireServer(wss: import("ws").WebSocketServer): void {
    // Subprotocol negotiation happens in verifyClient (see start); the
    // connection event below adopts the socket into a gateway session.
    wss.on("connection", (ws) => {
      // `ws.protocol` is already set by the library's subprotocol negotiation
      // in verifyClient; no manual assignment needed (the property is a getter).
      this.onConnection(ws);
    });
    wss.on("error", (error) => {
      this.log.error("websocket server error", { error: error.message });
    });
  }

  private onConnection(ws: WebSocket): void {
    const remoteAddr = this.remoteAddressOf(ws);

    // Per-IP flood protection (security audit §3.3): refuse new sockets from
    // an address that already holds the maximum connection slot, or whose
    // brute-force auth attempts triggered a ban.
    const banned = this.ipAuthBans.get(remoteAddr) ?? 0;
    if (Date.now() < banned) {
      this.log.warn("banned IP — refusing connection", { remote: remoteAddr });
      ws.close(4001, "auth banned");
      return;
    }
    if ((this.connectionsPerIp.get(remoteAddr) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
      this.log.warn("connection flood — refusing IP", { remote: remoteAddr });
      ws.close(4001, "too many connections");
      return;
    }
    this.connectionsPerIp.set(
      remoteAddr,
      (this.connectionsPerIp.get(remoteAddr) ?? 0) + 1,
    );

    ws.binaryType = "arraybuffer";
    const session: GatewaySession = {
      ws,
      metrics: new LatencyMetrics(),
      missedPongs: 0,
      connectedAt: Date.now(),
      lastPongTs: 0,
      // Pre-auth identity: connection fingerprint until Hello assigns a
      // stable session. Replaced by HelloAck's sessionId.
      authenticated: false,
      permissions: [],
      sessionId: `transient-${Math.random().toString(16).slice(2, 10)}`,
      // One-time auth challenge (§3.4): a fresh random nonce that the client
      // MUST echo inside Authenticate. Defeats replay of captured
      // Authenticate frames and pre-connection MITM injection.
      challenge: randomBytes(16).toString("hex"),
      seenMids: new Set<number>(),
    };
    this.sessions.set(ws, session);

    ws.on("message", (data) => this.onMessage(ws, session, data));
    ws.on("close", (code, reason) => {
      this.onClose(ws, session, code, reason.toString());
      this.decrementIpCount(remoteAddr);
    });
    ws.on("error", (error) => {
      this.log.error("socket error", { error: error.message });
      this.removeSession(ws);
      this.decrementIpCount(remoteAddr);
    });

    this.startWatchdog(ws, session);
    this.log.info("connection opened", { remote: remoteAddr });
  }

  // ── Frame ingress ────────────────────────────────────────────────────

  private async onMessage(
    ws: WebSocket,
    session: GatewaySession,
    raw: import("ws").RawData,
  ): Promise<void> {
    session.metrics.touch();

    // Text frames are never valid (§2.1).
    if (typeof raw === "string") {
      this.close(ws, CLOSE_CODES.UnsupportedVersion, "text frames not supported");
      return;
    }

    const bytes = raw as ArrayBuffer;
    if (bytes.byteLength > this.maxFrameBytes) {
      this.sendNack(ws, { t: 0, mid: 0, v: 1, ts: 0, p: {} }, "payloadTooLarge");
      return;
    }

    let frame: FrameEnvelope;
    try {
      const { decodeFrame } = await import("@kbm-remote/protocol");
      const { frame: decoded } = await decodeFrame(new Uint8Array(bytes));
      frame = decoded;
    } catch {
      this.sendNack(ws, { t: 0, mid: 0, v: 1, ts: 0, p: {} }, "malformed");
      return;
    }

    // Duplicate reliable frame (mid > 0) replay guard (§5.2): each seen mid is
    // remembered for the lifetime of the connection; a replay is Nacked and
    // the handler is NOT re-invoked.
    if (frame.mid > 0) {
      if (session.seenMids.has(frame.mid)) {
        this.sendNack(ws, frame, "replay");
        return;
      }
      session.seenMids.add(frame.mid);
    }

    if (frame.t === FrameType.Ping) {
      // Pre-auth Pings are answered (the receiver's latency probe), but they
      // MUST NOT touch the watchdog or pong accounting — otherwise a
      // connection flood could keep unauthenticated sockets alive forever
      // (security audit finding §3.2).
      if (session.authenticated) session.metrics.pingReceived();
      const pong: FrameEnvelope = {
        t: FrameType.Pong,
        mid: 0,
        v: frame.v,
        ts: Date.now(),
        p: { seq: frame.p.seq ?? null, serverTs: Date.now() },
      };
      this.sendTo(ws, pong);
      session.lastPongTs = Date.now();
      session.missedPongs = 0;
      return;
    }

    const ctx: FrameContext = {
      sessionId: session.sessionId,
      authenticated: session.authenticated,
      challenge: session.challenge,
      send: (f) => this.sendTo(ws, f),
      close: (code, reason) => this.close(ws, code, reason),
      setSessionId: (id) => {
        session.sessionId = id;
      },
      consumeChallenge: () => {
        const used = session.challenge;
        session.challenge = "";
        return used;
      },
    };

    const outcome = await this.router.route(frame, ctx);
    this.applyOutcome(ws, session, frame, outcome);
  }

  private applyOutcome(
    ws: WebSocket,
    session: GatewaySession,
    frame: FrameEnvelope,
    outcome: RouteOutcome,
  ): void {
    switch (outcome.kind) {
      case "ack": {
        // Reliable frames (mid > 0) earn an Ack after the handler applies them.
        void session;
        if (frame.mid > 0) {
          this.sendTo(ws, {
            t: FrameType.Ack,
            mid: 0,
            v: frame.v,
            ts: Date.now(),
            p: { mid: frame.mid },
          });
        }
        break;
      }
      case "nack": {
        this.sendNack(ws, frame, outcome.reason);
        break;
      }
      case "fatal": {
        this.close(ws, outcome.code, outcome.reason);
        break;
      }
    }
  }

  // ── Watchdog & health ────────────────────────────────────────────────

  private startWatchdog(ws: WebSocket, session: GatewaySession): void {
    const timer = setInterval(() => {
      // Pre-auth deadline: unauthenticated connections must complete Hello +
      // Authenticate within AUTH_TIMEOUT_MS, or the socket is dropped.
      // Without this, cheap anonymous connections could be parked forever.
      if (!session.authenticated) {
        const pending = Date.now() - session.connectedAt;
        if (pending > AUTH_TIMEOUT_MS) {
          this.log.warn("auth timeout — closing unauthenticated connection", {
            sessionId: session.sessionId,
            pendingMs: pending,
          });
          this.close(ws, CLOSE_CODES.NotAuthenticated, "auth timeout");
          return;
        }
        return; // watchdog for authenticated sessions only until paired
      }
      const idle = Date.now() - session.metrics.lastActivityAt;
      if (idle > SILENCE_WATCHDOG_MS) {
        this.log.warn("silence watchdog — closing dead connection", {
          sessionId: session.sessionId,
          idleMs: idle,
        });
        this.close(ws, CLOSE_CODES.NotAuthenticated, "heartbeat silence");
        return;
      }
      session.missedPongs += 1;
      if (session.missedPongs > MAX_MISSED_PONGS) {
        this.log.warn("missed pongs threshold — closing", {
          sessionId: session.sessionId,
          missed: session.missedPongs,
        });
        this.close(ws, CLOSE_CODES.NotAuthenticated, "heartbeat failure");
      }

      // Sustained high RTT → receiver-side WARN per §6.2.
      const median = session.metrics.rtt;
      if (median !== null && median > 75) {
        this.log.warn("sustained high latency", {
          sessionId: session.sessionId,
          rttMs: Math.round(median),
          jitterMs: Math.round(session.metrics.jitter),
        });
      }
    }, SILENCE_WATCHDOG_MS / 2);
    // Keep the timer from preventing graceful exit.
    timer.unref?.();
  }

  // ── Session helpers exposed to Hello/Authenticate handlers ───────────

  /**
   * Promote a connection to an authenticated session after AuthOk /
   * PairApproved has been sent. Called by the app's pairing/auth handlers.
   */
  authenticate(sessionId: string, permissions: string[]): GatewaySession | null {
    for (const session of this.sessions.values()) {
      if (session.sessionId === sessionId) {
        session.authenticated = true;
        session.permissions = permissions;
        this.log.info("session authenticated", { sessionId, permissions });
        return session;
      }
    }
    return null;
  }

  sessionFor(ws: WebSocket): GatewaySession | undefined {
    return this.sessions.get(ws);
  }

  /** Lookup a session by its transient (pre-Hello) or stable id. */
  sessionByTransientId(sessionId: string): GatewaySession | undefined {
    for (const session of this.sessions.values()) {
      if (session.sessionId === sessionId) return session;
    }
    return undefined;
  }

  /** Extract the remote address from the underlying socket. */
  private remoteAddressOf(ws: WebSocket): string {
    return (
      (ws as WebSocket & { _socket?: import("node:net").Socket })._socket
        ?.remoteAddress ?? "unknown"
    );
  }

  private decrementIpCount(ip: string): void {
    const current = this.connectionsPerIp.get(ip) ?? 0;
    if (current <= 1) {
      this.connectionsPerIp.delete(ip);
    } else {
      this.connectionsPerIp.set(ip, current - 1);
    }
  }

  /** Resolve an IP from a session id — used by the app layer to report auth failures for a connection. */
  recordAuthFailureFor(sessionId: string): number | null {
    const session = this.sessionByTransientId(sessionId);
    if (!session) return null;
    return this.recordAuthFailure(this.remoteAddressOf(session.ws));
  }

  /** Auth failure by raw address (testing / direct use). */
  recordAuthFailure(ip: string): number | null {
    // Record an auth failure for an IP. After `IP_AUTH_BAN_THRESHOLD` failures
    // inside `IP_AUTH_FAILURE_WINDOW_MS`, the address is banned for
    // `IP_AUTH_BAN_MS` (brute-force protection, §3.3). Returns the expiry of
    // the ban if one was triggered, else null.
    const now = Date.now();
    const windowStart = now - IP_AUTH_FAILURE_WINDOW_MS;
    const failures = (this.ipAuthFailures.get(ip) ?? []).filter((t) => t > windowStart);
    failures.push(now);
    this.ipAuthFailures.set(ip, failures);
    if (failures.length >= IP_AUTH_BAN_THRESHOLD) {
      const expiry = now + IP_AUTH_BAN_MS;
      this.ipAuthBans.set(ip, expiry);
      this.connectionsPerIp.delete(ip); // eject live flood sockets
      this.log.warn("IP banned for auth brute force", { remote: ip, expiry });
      return expiry;
    }
    return null;
  }

  /**
   * Resolve a session by its stable id — used by the input permission gate
   * and the dashboard. Linear scan; the session table is bounded by the
   * number of connected devices, so no index is needed.
   */
  sessionById(sessionId: string): GatewaySession | undefined {
    for (const session of this.sessions.values()) {
      if (session.sessionId === sessionId) return session;
    }
    return undefined;
  }

  /** Live snapshot of every gateway session. */
  allSessions(): IterableIterator<GatewaySession> {
    return this.sessions.values();
  }

  // ── Sending primitives ───────────────────────────────────────────────

  /** In-flight encode/send promises per socket — used by close() to flush. */
  private readonly pendingSends = new Map<WebSocket, Set<Promise<void>>>();

  sendTo(ws: WebSocket, frame: FrameEnvelope): void {
    if (ws.readyState !== ws.OPEN) return;
    const send: Promise<void> = import("@kbm-remote/protocol")
      .then(({ encodeFrame }) => encodeFrame(frame))
      .then((bytes) => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(bytes);
      })
      .catch((error) => {
        this.log.error("failed to encode/send frame", { error: String(error) });
      });
    let set = this.pendingSends.get(ws);
    if (!set) {
      set = new Set();
      this.pendingSends.set(ws, set);
      send.finally(() => {
        set!.delete(send);
        if (set!.size === 0) this.pendingSends.delete(ws);
      });
    }
    set.add(send);
  }

  private sendNack(ws: WebSocket, frame: FrameEnvelope, reason: string): void {
    void ws;
    this.sendTo(ws, {
      t: FrameType.Nack,
      mid: 0,
      v: frame.v,
      ts: Date.now(),
      p: { mid: frame.mid, reason },
    });
  }

  private close(ws: WebSocket, code: number, reason: string): void {
    if (ws.readyState === ws.OPEN) {
      // Any frames the handler queued on this same message (AuthOk/
      // AuthFailed, Disconnect echo, auto-Acks) must be flushed before the
      // close handshake fires — a synchronous close drops them. We therefore
      // wait for in-flight encode/send promises, bounded by a 1 s guard so a
      // stuck encoder never stalls shutdown.
      const pending = this.pendingSends.get(ws);
      const deadline = Promise.resolve().then(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 1000).unref?.();
          }),
      );
      const flush = pending
        ? Promise.race([Promise.allSettled(pending), deadline])
        : deadline;
      void flush.then(() => {
        if (ws.readyState === ws.OPEN) ws.close(code, reason);
        this.removeSession(ws);
      });
      return;
    }
    this.removeSession(ws);
  }

  private scheduleClose(
    ws: WebSocket,
    code: number,
    reason: string,
    waitMs: number,
  ): void {
    setTimeout(() => this.close(ws, code, reason), waitMs).unref?.();
  }

  private onClose(
    ws: WebSocket,
    session: GatewaySession,
    code: number,
    reason: string,
  ): void {
    this.log.info("connection closed", { sessionId: session.sessionId, code, reason });
    this.removeSession(ws);
  }

  private removeSession(ws: WebSocket): void {
    const session = this.sessions.get(ws);
    if (session) {
      this.log.info("session removed", { sessionId: session.sessionId });
    }
    this.sessions.delete(ws);
  }

  private async destroyServer(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
      this.server!.emit("close");
    });
    this.server = null;
  }
}
