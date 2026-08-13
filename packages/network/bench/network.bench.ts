/**
 * Network benchmark — per-frame send overhead on ClientConnection over a
 * real (loopback) WebSocket, including codec + socket queue.
 *
 * Run: pnpm exec tsx --tsconfig tsconfig.bench.json packages/network/bench/network.bench.ts
 */
import WebSocket, { WebSocketServer } from "ws";

import {
  ClientConnection,
  type ClientEvents,
  type ClientSocket,
} from "../src/client";
import { PING_INTERVAL_MS } from "../src/common";

let wss: WebSocketServer;
let serverSocket: WebSocket | undefined;

function serverSend(buffer: Uint8Array): void {
  const s = serverSocket;
  if (s && s.readyState === WebSocket.OPEN) s.send(buffer);
}

function createClient(): ClientConnection {
  const events: ClientEvents = {
    helloAck: () => undefined,
    authOk: () => undefined,
    message: () => undefined,
    metrics: () => undefined,
  };
  return new ClientConnection({
    url: "ws://127.0.0.1:9800",
    clientName: "benchmark",
    clientOs: "android",
    events,
    socketFactory: (url, protocols) => {
      const ws = new WebSocket(url, protocols);
      ws.binaryType = "arraybuffer";
      return ws as unknown as ClientSocket;
    },
  });
}

async function handshake(): Promise<void> {
  const s = serverSocket;
  if (!s) throw new Error("no server socket");
  // Echo every binary frame back so the client's handleMessage runs
  // (pong/RTT path included). The HelloAck is synthesized on first Hello.
  s.on("message", (data, isBinary) => {
    if (!isBinary || !Buffer.isBuffer(data)) return;
    try {
      const { decodeFrame, encodeFrame, FrameType } = require("@kbm-remote/protocol");
      decodeFrame(new Uint8Array(data)).then(({ frame }: { frame: { t: number; p: Record<string, unknown> } }) => {
        if (frame.t === FrameType.Hello) {
          // Ack immediately: sessionId assigned, no auth required.
          encodeFrame({
            t: FrameType.HelloAck,
            mid: 0,
            v: 1,
            ts: Date.now(),
            p: { sessionId: "bench-session", authRequired: false, serverTs: Date.now() },
          }).then((buf) => serverSend(new Uint8Array(buf)));
        } else if (frame.t === FrameType.Pong) {
          encodeFrame({
            t: FrameType.Pong,
            mid: 0,
            v: 1,
            ts: Date.now(),
            p: frame.p,
          }).then((buf) => serverSend(new Uint8Array(buf)));
        } else {
          // Echo so RTT watchdog activity stays fresh.
          serverSend(new Uint8Array(data));
        }
      }).catch(() => undefined);
    } catch {
      serverSend(new Uint8Array(data));
    }
  });
}

async function runSendBurst(): Promise<void> {
  const conn = createClient();
  await conn.connect();
  // Wait for the HelloAck → connected/authenticated.
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("handshake timeout")), 5000);
    const check = () => {
      if (conn.connectionState === "connected" || conn.connectionState === "authenticated") {
        clearTimeout(t);
        resolve();
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });

  const iters = 50_000;
  const start = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) {
    conn.send({
      t: 0x11,
      ts: Date.now(),
      p: { dx: i % 100, dy: i % 50, screen: 0 },
    });
  }
  // Drain async work.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`conn.send (mouseMove) throughput: ${Math.round((iters / elapsedMs) * 100) / 100} ops/ms`);

  conn.dispose();
}

async function main(): Promise<void> {
  wss = new WebSocketServer({ port: 9800, host: "127.0.0.1" });
  wss.on("connection", (socket) => {
    serverSocket = socket;
    void handshake();
  });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));

  console.log("=== Network benchmark (before optimization) ===");
  console.log(`heartbeat interval: ${PING_INTERVAL_MS} ms (constant, even when idle)`);
  await runSendBurst();

  wss.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
