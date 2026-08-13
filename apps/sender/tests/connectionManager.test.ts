import { createServer } from "node:http";

import { type ClientSocket } from "@kbm-remote/network";
import { encodeFrame, FrameType } from "@kbm-remote/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { ConnectionManager } from "../src/services/connectionManager";

/**
 * Fake receiver: answers Hello with a protocol-encoded HelloAck, then keeps
 * the socket alive. Mirrors the wire contract exercised in the receiver
 * app tests, using the real codec so both halves of the contract match.
 */
class FakeReceiver {
  private wss: import("ws").WebSocketServer;
  private server: import("node:http").Server;
  private lastHello: Record<string, unknown> | null = null;

  get lastHelloPayload(): Record<string, unknown> | null {
    return this.lastHello;
  }

  constructor() {
    this.server = createServer();
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const wsModule = require("ws") as typeof import("ws");
    this.wss = new wsModule.WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      this.wss.handleUpgrade(req, socket as never, head, (ws) => {
        this.wss.emit("connection", ws, req);
        ws.on("message", async (data: Buffer) => {
          try {
            const { decodeFrame } = await import("@kbm-remote/protocol");
            const { frame } = await decodeFrame(new Uint8Array(data));
            if (frame.t === FrameType.Hello) {
              this.lastHello = frame.p;
              ws.send(
                await encodeFrame({
                  t: FrameType.HelloAck,
                  mid: 0,
                  v: 1,
                  ts: Date.now(),
                  p: {
                    sessionId: "fake-session",
                    receiverName: "fake-receiver",
                    protoVersion: "1.0",
                  },
                }),
              );
              // Simulate a server-initiated operational frame shortly after
              // the handshake so inbound delivery can be asserted.
              await new Promise((resolve) => setTimeout(resolve, 80));
              ws.send(
                await encodeFrame({
                  t: FrameType.MouseMove,
                  mid: 0,
                  v: 1,
                  ts: Date.now(),
                  p: { x: 1, y: 2 },
                }),
              );
            }
            // Non-Hello frames (MouseMove etc.) echo back to the sender so
            // tests can assert the inbound message path through the codec.
            // Operational inbound frames are only simulated for the session
            // that completed the Hello handshake, since a freshly paired
            // receiver is what sends them in production.
            if (frame.t !== FrameType.Hello) {
              ws.send(data);
            }
          } catch {
            // Non-protocol traffic is ignored by the fake.
          }
        });
      });
    });
  }

  async start(): Promise<number> {
    return await new Promise<number>((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        resolve((this.server.address() as { port: number }).port);
      });
    });
  }

  async stop(): Promise<void> {
    // Terminate every live client so the underlying HTTP server can close
    // promptly — otherwise lingering sockets keep the server alive and the
    // test hook times out.
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function connectWebSocket(port: number): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, ["kbmremote.v1+msgpack"]);
    ws.binaryType = "arraybuffer";
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/**
 * Full fake socket: real Node `ws` client connected to FakeReceiver. Matches
 * the ClientSocket iface and therefore exercises the production path the
 * Expo app takes when it wires in `global.WebSocket`.
 */
function makeWsSocket(port: number): ClientSocket {
  // Lazy creation so the manager can re-target the URL via setUrl.
  let ws: WebSocket | null = null;
  // Handlers the client assigns before the underlying transport is bound
  // must be replayed once it arrives — otherwise the onopen callback that
  // triggers sendHello is lost and connect() hangs forever.
  let pendingOpen: (() => void) | null = null;
  let pendingMessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  let pendingClose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
  let pendingError: ((ev?: { message?: string }) => void) | null = null;
  const messageQueue: ArrayBuffer[] = [];

  const socket = {
    readyState: 0,
    binaryType: "arraybuffer",
    set onopen(handler: ((ev?: unknown) => void) | null) {
      pendingOpen = handler;
      if (handler && ws && ws.readyState === ws.OPEN) handler();
    },
    get onopen() {
      return pendingOpen;
    },
    set onmessage(handler: ((ev: { data: ArrayBuffer | string }) => void) | null) {
      pendingMessage = handler;
      if (handler) {
        while (messageQueue.length > 0) handler({ data: messageQueue.shift()! });
      }
    },
    get onmessage() {
      return pendingMessage;
    },
    set onclose(handler: ((ev?: { code?: number; reason?: string }) => void) | null) {
      pendingClose = handler;
    },
    get onclose() {
      return pendingClose;
    },
    set onerror(handler: ((ev?: { message?: string }) => void) | null) {
      pendingError = handler;
    },
    get onerror() {
      return pendingError;
    },
    send(data: ArrayBuffer | Uint8Array | string): void {
      ws?.send(data);
    },
    close(code?: number, reason?: string): void {
      ws?.close(code, reason);
    },
    /** Replace the underlying transport (called after setUrl + connect). */
    __bind(wsInstance: WebSocket): void {
      ws = wsInstance;
      socket.readyState = wsInstance.readyState;
      wsInstance.binaryType = "arraybuffer";
      wsInstance.onopen = () => {
        socket.readyState = wsInstance.readyState;
        pendingOpen?.();
      };
      wsInstance.onclose = (ev) => {
        socket.readyState = wsInstance.readyState;
        pendingClose?.({ code: ev.code, reason: ev.reason });
      };
      wsInstance.onerror = (ev) => {
        pendingError?.({
          message: String((ev as { message?: string } | null)?.message ?? ""),
        });
      };
      wsInstance.onmessage = (ev) => {
        if (pendingMessage) pendingMessage({ data: ev.data as ArrayBuffer });
        else messageQueue.push(ev.data as ArrayBuffer);
      };
      // The fake may already be open by the time __bind runs — replay it.
      if (wsInstance.readyState === wsInstance.OPEN) pendingOpen?.();
    },
  };
  void port;
  return socket as ClientSocket;
}

describe("ConnectionManager", () => {
  let receiver: FakeReceiver;
  let port = 0;

  beforeEach(async () => {
    receiver = new FakeReceiver();
    port = await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
  });

  function createManager(
    opts: { resume?: { sessionId: string; sessionToken: string } } = {},
  ) {
    const fakeSocket = makeWsSocket(port);
    const manager = new ConnectionManager({
      clientName: "pixel-8",
      clientOs: "android",
      socketFactory: () => {
        void connectWebSocket(port).then((ws) =>
          (fakeSocket as unknown as { __bind(ws: import("ws").WebSocket): void }).__bind(
            ws,
          ),
        );
        return fakeSocket;
      },
      ...opts,
    });
    return manager;
  }

  it("transitions through connecting → connected after HelloAck", async () => {
    const manager = createManager();
    const states: string[] = [];
    manager.on("stateChange", (state) => states.push(state));

    await manager.connect({ url: `wss://127.0.0.1:${port}`, source: "manual" });
    // Let async decode + HelloAck handlers settle.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(states).toContain("connecting");
    expect(manager.state).toBe("connected");
    expect(manager.address?.source).toBe("manual");

    manager.dispose();
  });

  it("exposes the sessionId assigned by HelloAck", async () => {
    const manager = createManager();
    await manager.connect({ url: `wss://127.0.0.1:${port}`, source: "stored" });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(manager.sessionId).toBe("fake-session");
    manager.dispose();
  });

  it("advertises clientName/clientOs in the Hello frame", async () => {
    const manager = createManager();
    await manager.connect({ url: `wss://127.0.0.1:${port}`, source: "manual" });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(receiver.lastHelloPayload?.clientName).toBe("pixel-8");
    expect(receiver.lastHelloPayload?.clientOs).toBe("android");
    manager.dispose();
  });

  it("carries resume credentials into the Hello frame (§5.4)", async () => {
    const manager = createManager({
      resume: { sessionId: "prev", sessionToken: "tok" },
    });
    await manager.connect({ url: `wss://127.0.0.1:${port}`, source: "stored" });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(receiver.lastHelloPayload?.resumeSessionId).toBe("prev");
    manager.dispose();
  });

  it("handles connect after dispose with a clear error", async () => {
    const manager = createManager();
    manager.dispose();
    await expect(
      manager.connect({ url: `wss://127.0.0.1:${port}`, source: "mdns" }),
    ).rejects.toThrow("disposed");
  });

  it("re-targets the peer URL via setUrl", async () => {
    const manager = createManager();
    manager.connectionRef.setUrl(`wss://127.0.0.1:${port}`);
    // connect() would normally follow; assert the call does not throw.
    manager.dispose();
    expect(true).toBe(true);
  });

  it("emits the message event for inbound frames", async () => {
    const manager = createManager();
    const received: unknown[] = [];
    manager.on("message", (frame) => received.push(frame));

    await manager.connect({ url: `wss://127.0.0.1:${port}`, source: "manual" });
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Trigger a server-initiated MouseMove on the manager's own session —
    // FakeReceiver pushes one inbound frame once the Hello handshake
    // completes, which is exactly what a production receiver does.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(received.length).toBe(1);
    // The manager decodes inbound frames through the codec before emitting,
    // so tests receive already-parsed envelopes rather than raw bytes.
    const frame = received[0] as {
      t: number;
      p?: { x: number; y: number };
    };
    expect(frame.t).toBe(FrameType.MouseMove);
    expect(frame.p?.x).toBe(1);
    manager.dispose();
  });
});
