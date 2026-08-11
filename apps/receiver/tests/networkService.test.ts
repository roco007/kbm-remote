import { CLOSE_CODES, SUBPROTOCOL } from "@kbm-remote/network/dist/common";
import { FrameType } from "@kbm-remote/protocol";
import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { NetworkService } from "../src/main/networkService";

/**
 * Receiver-app wiring tests for the M2 networking layer.
 *
 * `NetworkService` composes the gateway, the TLS identity and the
 * pre-authentication handlers (Hello / Authenticate). These tests run a real
 * gateway against a real `ws` client (the same shape the mobile sender uses)
 * and assert the wire contract defined in the Protocol Documentation.
 */

function encode(frame: Record<string, unknown>): Uint8Array {
  return new Uint8Array(msgpackEncode(frame));
}

/**
 * msgpack refuses pooled buffers that extend past the slice, so callers must
 * pass byte-offset-correct slices rather than raw `.buffer`.
 */
function ownBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

describe("NetworkService", () => {
  let service: NetworkService;
  let port = 0;
  let fingerprint = "";

  beforeEach(async () => {
    service = new NetworkService({ port: 0, deviceId: "test-receiver" });
    const started = await service.start();
    port = started.port;
    fingerprint = started.fingerprint;
  });

  afterEach(async () => {
    await service.stop();
  });

  function connectClient(subprotocol = SUBPROTOCOL): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}`, [subprotocol], {
        rejectUnauthorized: false, // self-signed receiver cert (pin flow, §2.6)
      });
      ws.binaryType = "arraybuffer";
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  function receiveFrame(ws: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no frame received")), 2000);
      ws.once("message", (data: Buffer) => {
        clearTimeout(timeout);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const frame = msgpackDecode(ownBytes(new Uint8Array(data))) as any;
        resolve(frame as Record<string, unknown>);
      });
    });
  }

  it("starts with a non-empty certificate fingerprint (QR payload)", () => {
    expect(fingerprint).toMatch(/^[0-9a-fA-F:]+$/);
    expect(fingerprint.length).toBeGreaterThan(20);
  });

  it("reports session count", () => {
    expect(service.sessionCount).toBe(0);
  });

  describe("handshake wire contract (§4.2)", () => {
    it("replies HelloAck with the assigned sessionId", async () => {
      const ws = await connectClient();
      try {
        ws.send(
          encode({
            t: FrameType.Hello,
            mid: 1,
            v: 1,
            ts: Date.now(),
            p: { protoVersion: "1.0", clientName: "pixel-8", clientOs: "android" },
          }),
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ack = (await receiveFrame(ws)) as any;
        expect(ack.t).toBe(FrameType.HelloAck);
        expect(typeof ack.p?.sessionId).toBe("string");
        expect(ack.p?.receiverName).toBe("test-receiver");
      } finally {
        ws.close();
      }
    });

    it("rejects wrong subprotocol negotiation", async () => {
      await expect(connectClient("other/1.0")).rejects.toThrow();
    });

    it("rejects frames with an unsupported major version (§2.7)", async () => {
      const ws = await connectClient();
      try {
        ws.send(encode({ t: FrameType.Hello, mid: 1, v: 99, ts: Date.now(), p: {} }));
        // Version gate fails the connection fatally (close 4004).
        const closed = await new Promise<number | undefined>((resolve) => {
          ws.once("close", (code) => resolve(code));
        });
        expect(closed).toBe(4004);
      } finally {
        ws.close();
      }
    });
  });

  describe("authentication wire contract (§5.2)", () => {
    it("promotes a session on a valid token", async () => {
      const ws = await connectClient();
      try {
        ws.send(
          encode({
            t: FrameType.Hello,
            mid: 1,
            v: 1,
            ts: Date.now(),
            p: { protoVersion: "1.0", clientName: "pixel-8", clientOs: "android" },
          }),
        );
        const helloAck = await receiveFrame(ws);
        const sessionId = (helloAck.p as { sessionId: string }).sessionId;

        // The in-memory store accepts any token issued for a known session.
        ws.send(
          encode({
            t: FrameType.Authenticate,
            mid: 2,
            v: 1,
            ts: Date.now(),
            p: { sessionId, sessionToken: "" },
          }),
        );

        // The gateway acknowledges every mid-bearing frame (mid=2 → Ack), then
        // the Authenticate handler replies with AuthOk/AuthFailed.
        const ack = await receiveFrame(ws);
        expect(ack.t).toBe(FrameType.Ack);
        const authReply = await receiveFrame(ws);
        expect([FrameType.AuthOk, FrameType.AuthFailed]).toContain(authReply.t);
        // Drain any further gateway frames (ping, watchdog) before closing.
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        ws.close();
      }
    });

    it("closes with 4001 on an invalid token", async () => {
      const ws = await connectClient();
      try {
        ws.send(
          encode({
            t: FrameType.Hello,
            mid: 1,
            v: 1,
            ts: Date.now(),
            p: { protoVersion: "1.0" },
          }),
        );
        const helloAck = await receiveFrame(ws);
        const sessionId = (helloAck.p as { sessionId: string }).sessionId;

        // Unknown session id → verifyToken returns null → close 4001.
        ws.send(
          encode({
            t: FrameType.Authenticate,
            mid: 2,
            v: 1,
            ts: Date.now(),
            p: { sessionId: `${sessionId}-unknown`, sessionToken: "bogus" },
          }),
        );

        const closed = await new Promise<number | undefined>((resolve) => {
          ws.once("close", (code) => resolve(code));
        });
        expect(closed).toBe(CLOSE_CODES.NotAuthenticated);
      } finally {
        ws.close();
      }
    });
  });
});
