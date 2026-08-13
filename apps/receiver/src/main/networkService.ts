/**
 * NetworkService — receiver-side host for the KBM Remote networking layer.
 *
 * Responsibilities (Milestone 2, Architecture §6.2):
 *   - Generate (or load) the receiver's self-signed TLS identity and expose
 *     the certificate fingerprint used for pairing QR codes (§2.6).
 *   - Own the `WssGateway` lifecycle: start on app launch, drain on exit.
 *   - Register the protocol-mandated pre-auth handlers (Hello, Authenticate)
 *     against the gateway's `FrameRouter`.
 *   - Hold the session token registry (AuthStore) — M1 will back this with
 *     persistent secure storage and the full pairing state machine.
 *
 * Wiring note: the gateway deliberately stays UI-free and framework-free.
 * The host application supplies the TLS server and the auth store; this class
 * is the thin composition root that connects them.
 */

import { createServer as createTlsServer } from "node:https";

// Why `node:https` and not `node:tls`? The `ws` library drives WebSocket
// upgrades through the HTTP `upgrade` event. Plain `tls.Server` instances do
// not emit that event, so a raw TLS server must be wrapped in an HTTPS
// server — the TLS machinery (certificate, ciphers, sessions) is identical.

import { AuthMiddleware, Logger, WssGateway } from "@kbm-remote/network";
import { FrameType } from "@kbm-remote/protocol";

import { createInputContainer, createInputService } from "./inputModule";

import type { Container } from "@kbm-remote/input-provider";
import type { GatewaySession } from "@kbm-remote/network";
import type { AuthStore } from "@kbm-remote/network";

const serviceLog = new Logger("networkService");

export interface SessionMeta {
  /** Client-supplied human label (sent in Hello §4.2). */
  clientName?: string;
  /** `android` | `ios` as advertised in Hello §4.2. */
  clientOs?: string;
}

export interface NetworkServiceOptions {
  /** Port to listen on (default 27001, KBM Remote convention). */
  port?: number;
  /** Device label embedded in the TLS certificate's CN and shown in QR codes. */
  deviceId?: string;
  /** Stored device registry (M1 will persist this). */
  authStore?: AuthStore;
}

const DEFAULT_PORT = 27001;

/**
 * Mutable per-session metadata the app layer can read for the dashboard.
 */

export class NetworkService {
  private readonly gateway: WssGateway;
  private readonly auth: AuthMiddleware;
  private readonly inputService: import("./inputService").InputService;
  private tlsServer: import("node:https").Server | null = null;
  private readonly deviceId: string;

  constructor(
    private readonly options: NetworkServiceOptions = {},
    inputContainer: Container = createInputContainer(),
  ) {
    this.deviceId = options.deviceId ?? "";
    const authStore = options.authStore ?? createDefaultAuthStore();
    this.auth = new AuthMiddleware({ store: authStore });

    this.gateway = new WssGateway({
      port: options.port ?? DEFAULT_PORT,
      auth: { store: authStore, authWindowMs: 30_000 },
      maxFrameBytes: 16 * 1024 * 1024,
    });

    // Mouse input handlers — the session lookup reads the gateway's auth
    // state, which the Authenticate handler populates on success.
    this.inputService = createInputService(inputContainer, (sessionId) =>
      this.gateway.sessionById(sessionId),
    );

    this.registerProtocolHandlers();
    this.inputService.registerHandlers(this.gateway.frameRouter);
  }

  /**
   * Bring up the gateway. The receiver identity is generated lazily so that
   * pairing metadata (device id, certificate fingerprint) is available
   * before any socket binds.
   */
  async start(): Promise<{
    port: number;
    fingerprint: string;
    deviceId: string;
  }> {
    // Dynamic import keeps the Node-only crypto path isolated from RN builds.
    const tls = await import("@kbm-remote/network/dist/transport/tls.js");
    const { key, cert } = await tls.generateSelfSignedCert({
      deviceId: this.deviceId || undefined,
    });
    const fingerprint = tls.fingerprintOf(cert);
    const deviceId = tls.deviceIdOf(cert);

    this.tlsServer = createTlsServer({ key, cert });

    // Bind the socket first — the gateway wires the WebSocket upgrade onto it
    // but the host app owns the bound address (port may be 0 for auto-assign).
    await new Promise<void>((resolve, reject) => {
      this.tlsServer!.once("error", reject);
      this.tlsServer!.listen(optionsPort(this.options), "0.0.0.0", () => {
        this.tlsServer!.off("error", reject);
        resolve();
      });
    });

    await this.gateway.start(this.tlsServer as never);

    const boundPort = (this.tlsServer.address() as import("node:net").AddressInfo).port;
    serviceLog.info("network service started", {
      port: boundPort,
      fingerprint,
      deviceId,
    });

    return { port: boundPort, fingerprint, deviceId };
  }

  async stop(): Promise<void> {
    this.tlsServer?.close();
    await this.gateway.stop();
    serviceLog.info("network service stopped");
  }

  get sessionCount(): number {
    return this.gateway.sessionCount;
  }

  /** Live session metadata for the dashboard (identity, permissions, latency). */
  sessions(): IterableIterator<GatewaySession> {
    return this.gateway.allSessions();
  }

  private registerProtocolHandlers(): void {
    const router = this.gateway.frameRouter;

    // Hello (§4.2): adopt the stable sessionId for the connection and issue
    // HelloAck. The Authenticate handler below promotes it to an
    // authenticated session once a valid token arrives.
    router.register(FrameType.Hello, async (frame, ctx) => {
      const p = frame.p as {
        protoVersion?: string;
        clientName?: string;
        clientOs?: string;
      };

      ctx.send({
        t: FrameType.HelloAck,
        mid: 0,
        v: 1,
        ts: Date.now(),
        p: {
          sessionId: ctx.sessionId,
          receiverName: this.deviceId || "kbm-receiver",
          protoVersion: p?.protoVersion ?? "unknown",
        },
      });

      return { ok: true };
    });

    // Authenticate (§5.2): verify the stored session token via the auth
    // middleware, promote on success, close with 4001 on failure.
    router.register(FrameType.Authenticate, async (frame, ctx) => {
      const p = frame.p as { sessionId: string; sessionToken: string };
      const decision = await this.auth.verifyAuthenticate(p.sessionId, p.sessionToken);

      if (!decision.ok) {
        ctx.send({
          t: FrameType.AuthFailed,
          mid: 0,
          v: 1,
          ts: Date.now(),
          p: { reason: "tokenInvalid" },
        });
        ctx.close(4001, "tokenInvalid");
        return { ok: false, reason: "notAuthenticated" };
      }

      const session = this.gateway.authenticate(p.sessionId, decision.permissions);
      if (!session) {
        ctx.close(4001, "unknownSession");
        return { ok: false, reason: "notAuthenticated" };
      }

      ctx.send({
        t: FrameType.AuthOk,
        mid: 0,
        v: 1,
        ts: Date.now(),
        p: { sessionId: p.sessionId, permissions: decision.permissions },
      });

      serviceLog.info("session promoted to authenticated", {
        sessionId: p.sessionId,
        permissions: decision.permissions,
      });
      return { ok: true };
    });
  }
}

function optionsPort(options: NetworkServiceOptions): number {
  return options.port ?? DEFAULT_PORT;
}

/**
 * Minimal in-memory auth store used until M1 ships persistent storage.
 * Tokens are issued as opaque hex identifiers; verification is a plain
 * equality check against the registry. Per Spec §5.1 the M1 store MUST
 * hash tokens before persisting them.
 */
function createDefaultAuthStore(): AuthStore {
  const tokens = new Map<string, string>();
  const revoked = new Set<string>();
  let pairingAttempts = 0;

  return {
    async verifyToken(sessionId: string, token: string) {
      if (revoked.has(sessionId)) return null;
      return tokens.get(sessionId) === token ? ["keyboard", "mouse"] : null;
    },
    async storeSession(sessionId: string, token: string) {
      tokens.set(sessionId, token);
    },
    async revokeSession(sessionId: string) {
      revoked.add(sessionId);
      tokens.delete(sessionId);
    },
    async isRateLimited() {
      return pairingAttempts > 20;
    },
    async recordPairingAttempt() {
      pairingAttempts += 1;
    },
  };
}
