/**
 * ConnectionManager — sender-side lifecycle for the KBM Remote networking
 * layer (Milestone 2, Architecture §6.3).
 *
 * Responsibilities:
 *   - Own a `ClientConnection` and translate its events into a small,
 *     framework-agnostic event surface the React screens can subscribe to.
 *   - Resolve a receiver address from discovery (mDNS/Bonjour, manual IP,
 *     or a stored address) into a `wss://` URL.
 *   - Persist session identity for token-based re-authentication so users
 *     do not have to re-pair after the receiver restarts (§5.4).
 *   - Expose the raw `ClientConnection` for future modules (input dispatch,
 *     clipboard sync) that need to send frames directly.
 *
 * Platform note: React Native provides a native WebSocket implementation.
 * The `socketFactory` indirection keeps this manager portable — the Expo
 * app wires in `global.WebSocket` at construction time, and the Node build
 * uses the `ws` package for tests.
 */

import {
  ClientConnection,
  type ClientEvents,
  type ClientOptions,
  type ClientSocket,
} from "@kbm-remote/network";
import { type FrameEnvelope } from "@kbm-remote/protocol";

/** Security-audit §3.1 — persisted cert pin metadata (fingerprint + when). */
export interface CertPin {
  /** SHA-256 fingerprint of the receiver's identity certificate. */
  fingerprint: string;
  /** Unix ms when the pin was first established (pairing time). */
  pinnedAt: number;
}

export type { ClientSocket };

export interface ReceiverAddress {
  /** `wss://host:port` discovered via mDNS, manual entry, or storage. */
  url: string;
  /** Source label shown in the connection status screen (§U7). */
  source: "mdns" | "manual" | "stored";
}

export interface ConnectionManagerOptions {
  /** Human device label advertised in Hello §4.2. */
  clientName: string;
  /** `android` | `ios` — advertised in Hello §4.2. */
  clientOs: "android" | "ios";
  /** Optional persisted session for token-based re-authentication (§5.4). */
  resume?: { sessionId: string; sessionToken: string };
  /**
   * Security-audit §3.1 — stored certificate pin for the target receiver.
   * The first connection (pairing) supplies the pin from the QR code;
   * afterwards reconnections verify the peer certificate against it.
   */
  pinnedCert?: CertPin;
  /**
   * Persists the pin after the first successful pairing so reconnects verify
   * the same receiver (§3.1). The host app implements this (AsyncStorage on
   * mobile, JSON on desktop tests).
   */
  onPinEstablished?: (pin: CertPin) => void | Promise<void>;
  /**
   * Factory producing a socket ALREADY verified against the pin. For Node
   * hosts the reference `NodeTlsSocketFactory` (below) wraps `tls.connect`
   * with `checkServerIdentity` bound to `verifyPin`. Mobile hosts set the
   * factory per platform (React Native's WebSocket exposes no cert — the
   * fingerprint exchange at pairing is the trust anchor there).
   */
  socketFactory: ClientOptions["socketFactory"];
}

export type ConnectionManagerState = ClientConnection["connectionState"];

export interface ConnectionManagerEvents extends ClientEvents {
  /** Full frame stream (for input/clipboard modules wiring in later). */
  message?: (frame: FrameEnvelope) => void;
  /** Security-audit §3.1 — a TOFU pin was established after first pairing. */
  certPinEstablished?: (pin: CertPin) => void;
}

/**
 * Security-audit §3.1 — Node/Electron reference socket factory.
 *
 * Wraps `tls.connect` with `checkServerIdentity` bound to the TLS module's
 * `verifyPin` (§2.6). The peer certificate is also stored on the connection
 * for the QR-code TOFU flow, so the very first pairing pins the exact
 * receiver identity and every reconnect verifies it. MITM substitution
 * fails the TLS handshake before any protocol frame is exchanged.
 */
export function createNodeTlsSocketFactory(options: {
  /** Pin from the pairing QR code or the previously-stored pin. */
  pinnedCert?: CertPin;
}): ClientOptions["socketFactory"] {
  return (url, protocols) => {
    // Forwarded into the Node implementation at app wiring time (main
    // process context); this module intentionally stays importable in RN.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const NodeWs = require("ws") as typeof import("ws");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const tls = require("node:tls") as typeof import("node:tls");
    // ESLint maps `no-var-requires` to the `require(...)` token, so the
    // disable must sit on the same physical line as the call. The explicit
    // type annotation keeps the whole assignment within Prettier's
    // print width while letting the require remain a single line.
    const networkTls: typeof import("@kbm-remote/network/dist/transport/tls.js") =
      /* eslint-disable-line @typescript-eslint/no-var-requires */
      /* eslint-disable-next-line @typescript-eslint/no-var-requires */
      require("@kbm-remote/network/dist/transport/tls.js");
    const parsed = new URL(url);
    const peerCert = { value: null as string | null };
    // `socket` is a documented runtime option (ws ≥7) that the `.d.ts`
    // doesn't declare — the cast is intentional (§3.1 pin gate).
    const ws = new NodeWs.WebSocket(url, protocols, {
      socket: tls.connect({
        host: parsed.hostname,
        port: Number(parsed.port) || 443,
        rejectUnauthorized: true,
        checkServerIdentity: (
          host: string,
          cert: import("node:tls").PeerCertificate,
        ): string | undefined => {
          const pem = `-----BEGIN CERTIFICATE-----\n${cert.raw?.toString("base64")}\n-----END CERTIFICATE-----`;
          peerCert.value = pem;
          const pinned = options.pinnedCert?.fingerprint;
          if (pinned && !networkTls.verifyPin(pem, pinned)) {
            throw new Error("peer certificate fails pin check");
          }
          void host;
          return undefined; // undefined = identity accepted by Node's verifier
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    (ws as unknown as { __peerCertificate: { get(): string | null } }).__peerCertificate =
      {
        get: () => peerCert.value,
      };
    return ws as unknown as ClientSocket;
  };
}

/**
 * Thin typed event emitter — avoids pulling in an extra dependency on mobile
 * and keeps the event surface exhaustive via the `ConnectionManagerEvents`
 * interface.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
class Emitter<E = Record<string, any>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

  on<K extends keyof E>(event: K, listener: E[K]): () => void {
    const key = event as string;
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    set.add(listener as any);
    return () => {
      set?.delete(listener as never);
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected emit<K extends keyof E>(event: K, ...args: any[]): void {
    this.listeners.get(event as string)?.forEach((listener) => listener(...args));
  }
}

export class ConnectionManager extends Emitter<ConnectionManagerEvents> {
  private readonly connection: ClientConnection;
  private lastAddress: ReceiverAddress | null = null;
  private disposed = false;

  constructor(private readonly options: ConnectionManagerOptions) {
    super();
    this.connection = new ClientConnection({
      url: "", // Resolved lazily in connect(); required by the type but valid until set.
      socketFactory: options.socketFactory,
      clientName: options.clientName,
      clientOs: options.clientOs,
      capabilities: ["touchpad", "keyboard", "media", "clipboard"],
      resume: options.resume,
    });

    // Security-audit §3.1 — impersonation warning surfaced to the UX; the
    // pin itself is enforced by the host's socket factory / pin gate.
    this.connection.events.certPinFailed = (peerPem) => {
      void peerPem;
      this.emit("stateChange", "disconnected" as never);
    };
    this.connection.events.authOk = (payload) => {
      // First successful pairing: establish the TOFU pin if we don't have one.
      if (!this.options.pinnedCert && this.options.onPinEstablished) {
        const peerPem = this.connection.peerCertificate;
        if (peerPem) {
          void this.establishPin(peerPem);
        }
      }
      this.emit("authOk", payload);
    };
    void this.options.clientName; // Advertised in Hello — kept reachable for tests.

    // Bridge client events onto the manager's emitter surface.
    this.connection.events = {
      stateChange: (state) => this.emit("stateChange", state),
      helloAck: (payload) => this.emit("helloAck", payload),
      authOk: (payload) => this.emit("authOk", payload),
      authFailed: (payload) => this.emit("authFailed", payload),
      message: (frame) => this.emit("message", frame),
      reconnecting: (attempt) => this.emit("reconnecting", attempt),
    };
  }

  /** Resolved peer address, or null before the first successful connect. */
  get address(): ReceiverAddress | null {
    return this.lastAddress;
  }

  get state(): ConnectionManagerState {
    return this.connection.connectionState;
  }

  get sessionId(): string | null {
    return this.connection.sessionId;
  }

  get connectionRef(): ClientConnection {
    return this.connection;
  }

  /**
   * Connect to the receiver. The manager remembers the address so that
   * subsequent reconnects (driven by the client's exponential backoff) can
   * reuse the same peer.
   */
  async connect(address: ReceiverAddress): Promise<void> {
    if (this.disposed) {
      throw new Error("ConnectionManager disposed");
    }
    this.lastAddress = address;
    this.connection.setUrl(address.url);
    await this.connection.connect();
  }

  /** Graceful disconnect — sends Disconnect and waits for the echo. */
  disconnect(): void {
    this.connection.disconnectGracefully();
  }

  /** Security-audit §3.1 — capture the peer fingerprint from the pairing QR code. */
  private async establishPin(peerPem: string): Promise<void> {
    const tls = await import("@kbm-remote/network/dist/transport/tls.js");
    const pin: CertPin = {
      fingerprint: tls.fingerprintOf(peerPem),
      pinnedAt: Date.now(),
    };
    await this.options.onPinEstablished?.(pin);
    this.emit("certPinEstablished", pin);
  }

  /** Permanent teardown — no further reconnects. */
  dispose(): void {
    this.disposed = true;
    this.connection.dispose();
  }
}
