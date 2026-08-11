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
  /** Socket implementation; Expo apps pass `global.WebSocket` here. */
  socketFactory: ClientOptions["socketFactory"];
  /** Optional persisted session for token-based re-authentication (§5.4). */
  resume?: { sessionId: string; sessionToken: string };
}

export type ConnectionManagerState = ClientConnection["connectionState"];

export interface ConnectionManagerEvents extends ClientEvents {
  /** Full frame stream (for input/clipboard modules wiring in later). */
  message?: (frame: FrameEnvelope) => void;
}

/**
 * Thin typed event emitter — avoids pulling in an extra dependency on mobile
 * and keeps the event surface exhaustive via the `ConnectionManagerEvents`
 * interface.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
class Emitter<E = Record<string, any>> {
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

  /** Permanent teardown — no further reconnects. */
  dispose(): void {
    this.disposed = true;
    this.connection.dispose();
  }
}
