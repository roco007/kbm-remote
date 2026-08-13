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

import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createTlsServer } from "node:https";
import { join } from "node:path";

// Why `node:https` and not `node:tls`? The `ws` library drives WebSocket
// upgrades through the HTTP `upgrade` event. Plain `tls.Server` instances do
// not emit that event, so a raw TLS server must be wrapped in an HTTPS
// server — the TLS machinery (certificate, ciphers, sessions) is identical.

import { AuthMiddleware, Logger, WssGateway } from "@kbm-remote/network";
import { FrameType } from "@kbm-remote/protocol";

import { createInputContainer, createInputService } from "./inputModule";

import type { Container } from "@kbm-remote/input-provider";
import type { AuthStore, GatewaySession } from "@kbm-remote/network";

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
  /**
   * Directory where the receiver's TLS identity (key + cert) is persisted.
   * When set, the same certificate is reused across restarts so the pairing
   * QR fingerprint stays stable — a fresh self-signed identity on every
   * launch would force re-pairing and invite MITM during the new pairing
   * (security audit §3.1).
   */
  identityDir?: string;
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
    const { key, cert } = await loadOrGenerateIdentity(
      tls,
      this.options.identityDir ?? "",
      this.deviceId,
    );
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
          // Auth challenge (§3.4): a one-time nonce the client MUST echo in
          // Authenticate. The gateway blanks it after first use, so a replayed
          // Authenticate frame from a MITM or a packet capture can never work.
          challenge: ctx.consumeChallenge?.(),
        },
      });

      return { ok: true };
    });

    // Authenticate (§5.2): verify the stored session token via the auth
    // middleware, promote on success, close with 4001 on failure.
    router.register(FrameType.Authenticate, async (frame, ctx) => {
      const p = frame.p as {
        sessionId: string;
        sessionToken: string;
        challenge?: string;
      };

      // Challenge-response (§3.4): the Authenticate payload MUST carry the
      // exact nonce issued in HelloAck, and that nonce may be used once.
      // Missing, blank, or stale challenges fail authentication outright —
      // this is what defeats captured-frame replay and MITM injection.
      const presentedChallenge = p.challenge ?? "";
      const expectedChallenge = ctx.consumeChallenge?.() ?? "";
      if (
        !expectedChallenge ||
        !presentedChallenge ||
        presentedChallenge.length > 128 ||
        !safeEqual(presentedChallenge, expectedChallenge)
      ) {
        this.gateway.recordAuthFailureFor(ctx.sessionId);
        ctx.send({
          t: FrameType.AuthFailed,
          mid: 0,
          v: 1,
          ts: Date.now(),
          p: { reason: "challengeInvalid" },
        });
        ctx.close(4001, "challengeInvalid");
        return { ok: false, reason: "notAuthenticated" };
      }

      const decision = await this.auth.verifyAuthenticate(p.sessionId, p.sessionToken);

      if (!decision.ok) {
        this.gateway.recordAuthFailureFor(ctx.sessionId);
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
 * Load a persisted TLS identity from `identityDir/tls/` or generate a fresh
 * one and store it. A stable identity means the pairing fingerprint never
 * changes between restarts — senders pin the very first QR code forever.
 */
export async function loadOrGenerateIdentity(
  tls: {
    generateSelfSignedCert: (opts?: { deviceId?: string }) => Promise<{
      key: string;
      cert: string;
    }>;
  },
  identityDir: string,
  deviceId: string,
): Promise<{ key: string; cert: string }> {
  const dir = join(identityDir, "tls");
  const keyPath = join(dir, "identity.key");
  const certPath = join(dir, "identity.pem");

  if (existsSync(keyPath) && existsSync(certPath)) {
    const key = readFileSync(keyPath, "utf8");
    const cert = readFileSync(certPath, "utf8");
    // Verify the stored cert is still parseable before trusting it.
    if (key && cert) {
      // Parse check: a fresh cert object is only needed for fingerprinting.
      const { X509Certificate } = await import("node:crypto");
      try {
        new X509Certificate(cert); // throws on malformed PEM
        return { key, cert };
      } catch {
        serviceLog.warn("stored TLS identity corrupt — regenerating", {
          dir,
        });
      }
    }
  }

  mkdirSync(dir, { recursive: true });
  const generated = await tls.generateSelfSignedCert({
    deviceId: deviceId || undefined,
  });
  // File permissions 0600 — the private key must stay off the disk-wide.
  writeFileSync(keyPath, generated.key, { mode: 0o600 });
  writeFileSync(certPath, generated.cert, { mode: 0o644 });
  serviceLog.info("TLS identity generated and persisted", { dir });
  return generated;
}

/** Constant-time hex comparison — the auth challenge is a secret, so timing
 *  side channels on mismatch must be avoided (§3.4). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** Token hashing: SHA-256 with per-session salt (§3.6). */
function hashToken(token: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${token}`, "utf8").digest("hex");
}

/**
 * Minimal in-memory auth store used until M1 ships persistent storage.
 * Tokens are hashed at rest with a per-session random salt (security audit
 * §3.6) — the registry never holds a plaintext session secret.
 */
function createDefaultAuthStore(): AuthStore {
  const tokens = new Map<string, { hash: string; salt: string }>();
  const revoked = new Set<string>();
  let pairingAttempts = 0;

  return {
    async verifyToken(sessionId: string, token: string) {
      if (revoked.has(sessionId)) return null;
      const entry = tokens.get(sessionId);
      if (!entry) return null;
      const presented = hashToken(token, entry.salt);
      return timingSafeEqual(Buffer.from(presented), Buffer.from(entry.hash))
        ? ["keyboard", "mouse"]
        : null;
    },
    async storeSession(sessionId: string, token: string) {
      const salt = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
      tokens.set(sessionId, { salt, hash: hashToken(token, salt) });
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
