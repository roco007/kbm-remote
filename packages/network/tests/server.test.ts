import { createServer, type Server as HttpServer } from "node:http";

import { FrameType } from "@kbm-remote/protocol";
import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { CLOSE_CODES, SUBPROTOCOL } from "../src/common";
import { AuthMiddleware, type AuthStore } from "../src/server/authMiddleware";
import {
  FrameRouter,
  handlerSuccess,
  PRE_AUTH_TYPES,
  type FrameContext,
} from "../src/server/frameRouter";
import { WssGateway } from "../src/server/WssGateway";

/**
 * Server-side transport: FrameRouter pre-auth gate + Ack/Nack outcomes,
 * AuthMiddleware token verification, and the WssGateway end-to-end.
 */

const SESSION_ID = "sess-1";

function makeStore(opts: {
  tokenOk: boolean;
  revoked: boolean;
  rateLimited: boolean;
}): AuthStore {
  let _attempts = 0;
  return {
    async verifyToken(_sessionId: string, _token: string) {
      if (opts.revoked) return null;
      return opts.tokenOk ? ["keyboard", "mouse"] : null;
    },
    async storeSession() {
      return undefined;
    },
    async revokeSession() {
      return undefined;
    },
    async isRateLimited() {
      return opts.rateLimited;
    },
    async recordPairingAttempt() {
      _attempts += 1;
    },
  };
}

function makeGateway(store: AuthStore) {
  const gateway = new WssGateway({
    port: 0,
    auth: { store, authWindowMs: 30_000 },
    maxFrameBytes: 1024 * 1024,
  });

  // Register the Hello handler — app-level pairing logic is M1, but the
  // gateway replies HelloAck here so the wire contract can be exercised.
  gateway.frameRouter.register(FrameType.Hello, async (frame, ctx) => {
    const sessionId =
      (frame.p as { resumeSessionId?: string }).resumeSessionId ??
      `sess-${Date.now().toString(16)}`;
    ctx.setSessionId?.(sessionId);
    ctx.send({
      t: FrameType.HelloAck,
      mid: 0,
      v: 1,
      ts: Date.now(),
      p: {
        serverVersion: "1.0",
        sessionId,
        serverTs: Date.now(),
        authRequired: true,
        capabilities: [],
        maxInFlight: 16,
        permissions: [],
      },
    });
    return handlerSuccess();
  });

  // Register a trivial operational handler — app business logic is M3+,
  // but the router needs at least one route to exercise the auth gate.
  gateway.frameRouter.register(FrameType.MouseMove, async (_frame, _ctx) => {
    return handlerSuccess();
  });

  return gateway;
}

function encode(frame: Record<string, unknown>): Uint8Array {
  return new Uint8Array(msgpackEncode(frame));
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

describe("FrameRouter", () => {
  let router: FrameRouter;
  let ctx: FrameContext;
  const baseFrame = {
    t: FrameType.MouseMove,
    mid: 0,
    v: 1,
    ts: 0,
    p: { x: 0, y: 0 },
  };

  beforeEach(() => {
    router = new FrameRouter();
    ctx = {
      sessionId: SESSION_ID,
      authenticated: false,
      send: () => undefined,
      close: () => undefined,
    };
  });

  it("routes an authenticated operational frame to its handler", async () => {
    const called: unknown[] = [];
    router.register(FrameType.MouseMove, async (frame) => {
      called.push(frame.t);
      return handlerSuccess();
    });

    const outcome = await router.route({ ...baseFrame }, { ...ctx, authenticated: true });
    expect(outcome.kind).toBe("ack");
    expect(called).toEqual([FrameType.MouseMove]);
  });

  it("nacks unauthenticated operational frames (pre-auth gate §3.3)", async () => {
    const called: unknown[] = [];
    router.register(FrameType.MouseMove, async (frame) => {
      called.push(frame.t);
      return handlerSuccess();
    });

    const outcome = await router.route({ ...baseFrame }, ctx);
    expect(outcome.kind).toBe("nack");
    if (outcome.kind === "nack") expect(outcome.reason).toBe("notAuthenticated");
    expect(called).toHaveLength(0);
  });

  it("allows the pairing flow before authentication", async () => {
    for (const type of [
      FrameType.Hello,
      FrameType.PairRequest,
      FrameType.PairResponse,
      FrameType.Authenticate,
    ]) {
      router.register(type, async () => handlerSuccess());
      const outcome = await router.route({ t: type, mid: 0, v: 1, ts: 0, p: {} }, ctx);
      expect(outcome.kind).toBe("ack");
    }
    // Sanity: the gate list is exactly those four types.
    expect(PRE_AUTH_TYPES.size).toBe(4);
  });

  it("nacks unknown type discriminators instead of throwing", async () => {
    const outcome = await router.route(
      { t: 0xe1, mid: 0, v: 1, ts: 0, p: {} }, // unregistered type
      { ...ctx, authenticated: true },
    );
    expect(outcome.kind).toBe("nack");
    if (outcome.kind === "nack") expect(outcome.reason).toBe("unknownType");
  });

  it("returns fatal for major version mismatch (§2.7)", async () => {
    router.register(FrameType.MouseMove, async () => handlerSuccess());
    const outcome = await router.route(
      { ...baseFrame, v: 2 },
      { ...ctx, authenticated: true },
    );
    expect(outcome.kind).toBe("fatal");
    if (outcome.kind === "fatal")
      expect(outcome.code).toBe(CLOSE_CODES.IncompatibleVersion);
  });

  it("maps handler refusal to a typed Nack (§6.1)", async () => {
    router.register(FrameType.MouseMove, async () => ({
      ok: false,
      reason: "permissionDenied" as const,
    }));

    const outcome = await router.route({ ...baseFrame }, { ...ctx, authenticated: true });
    expect(outcome.kind).toBe("nack");
    if (outcome.kind === "nack") expect(outcome.reason).toBe("permissionDenied");
  });

  it("translates thrown FrameHandlerError into its typed result", async () => {
    const { FrameHandlerError } = await import("../src/server/gatewayTypes.js");
    router.register(FrameType.MouseMove, async () => {
      throw new FrameHandlerError({ ok: false, reason: "malformed" });
    });

    const outcome = await router.route({ ...baseFrame }, { ...ctx, authenticated: true });
    expect(outcome.kind).toBe("nack");
    if (outcome.kind === "nack") expect(outcome.reason).toBe("malformed");
  });

  it("translates unknown thrown errors into a malformed Nack", async () => {
    router.register(FrameType.MouseMove, async () => {
      throw new Error("boom");
    });

    const outcome = await router.route({ ...baseFrame }, { ...ctx, authenticated: true });
    expect(outcome.kind).toBe("nack");
    if (outcome.kind === "nack") expect(outcome.reason).toBe("malformed");
  });
});

describe("AuthMiddleware", () => {
  it("verifies a valid session token", async () => {
    const middleware = new AuthMiddleware({
      store: makeStore({ tokenOk: true, revoked: false, rateLimited: false }),
    });
    const decision = await middleware.verifyAuthenticate(SESSION_ID, "good-token");
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.permissions).toEqual(["keyboard", "mouse"]);
  });

  it("rejects unknown or revoked tokens as invalid", async () => {
    const validStore = new AuthMiddleware({
      store: makeStore({ tokenOk: false, revoked: false, rateLimited: false }),
    });
    expect((await validStore.verifyAuthenticate(SESSION_ID, "bad")).ok).toBe(false);

    const revokedStore = new AuthMiddleware({
      store: makeStore({ tokenOk: true, revoked: true, rateLimited: false }),
    });
    expect((await revokedStore.verifyAuthenticate(SESSION_ID, "t")).ok).toBe(false);
  });

  it("tracks the 30 s auth window", async () => {
    const middleware = new AuthMiddleware({
      store: makeStore({ tokenOk: true, revoked: false, rateLimited: false }),
    });
    const openedAt = Date.now() - 29_000;
    expect(middleware.isAuthWindowExpired(openedAt)).toBe(false);
    expect(middleware.isAuthWindowExpired(Date.now() - 31_000)).toBe(true);
  });

  it("produces a typed auth-failed refusal for handlers", () => {
    const result = AuthMiddleware.authFailed();
    expect(result).toEqual({ ok: false, reason: "notAuthenticated" });
  });
});

describe("WssGateway end-to-end", () => {
  let gateway: WssGateway;
  let httpServer: HttpServer;
  let client: WebSocket;
  let port = 0;

  beforeEach(async () => {
    httpServer = await new Promise<HttpServer>((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as { port: number }).port;
        resolve(server);
      });
    });

    gateway = makeGateway(
      makeStore({ tokenOk: true, revoked: false, rateLimited: false }),
    );
    await gateway.start(httpServer as unknown as import("node:tls").Server);
    expect(gateway.gatewayState).toBe("listening");
  });

  afterEach(async () => {
    client?.close();
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  function connectClient(subprotocol = SUBPROTOCOL): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, [subprotocol]);
      ws.binaryType = "arraybuffer";
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  function receiveFrame(ws: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no frame received")), 2000);
      ws.once("message", (data) => {
        clearTimeout(timeout);
        resolve(
          msgpackDecode(ownBytes(new Uint8Array(data as ArrayBuffer))) as Record<
            string,
            unknown
          >,
        );
      });
    });
  }

  it("rejects connections without the negotiated subprotocol", async () => {
    // A bogus subprotocol gets an HTTP 400 — the ws client surfaces it as an
    // error before any frame can round-trip. The gateway never registers a
    // session.
    const error = await new Promise<Error | null>((resolve) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}`, ["plain"]);
      s.binaryType = "arraybuffer";
      s.once("open", () => resolve(null));
      s.once("error", (err) => resolve(err as Error));
    });
    expect(error).toBeTruthy();
    expect(gateway.sessionCount).toBe(0);
  });

  it("runs the Hello handshake and assigns a session id", async () => {
    client = await connectClient();
    const helloAckPromise = receiveFrame(client);

    client.send(
      encode({
        t: FrameType.Hello,
        mid: 0,
        v: 1,
        ts: Date.now(),
        p: {
          protoVersion: "1.0",
          clientName: "test-phone",
          clientOs: "android",
          capabilities: [],
          clientTs: Date.now(),
        },
      }),
    );

    const ack = await helloAckPromise;
    await new Promise((r) => setTimeout(r, 0));
    expect(ack.t).toBe(FrameType.HelloAck);
    expect(typeof (ack.p as { sessionId: string }).sessionId).toBe("string");
    expect(gateway.sessionCount).toBe(1);
  });

  it("nacks operational frames before authentication", async () => {
    client = await connectClient();
    const nackPromise = receiveFrame(client); // expect HelloAck first
    client.send(
      encode({
        t: FrameType.Hello,
        mid: 0,
        v: 1,
        ts: 0,
        p: {
          protoVersion: "1.0",
          clientName: "x",
          clientOs: "android",
          capabilities: [],
          clientTs: 0,
        },
      }),
    );
    const helloAck = await nackPromise;
    expect(helloAck.t).toBe(FrameType.HelloAck);

    const nackResult = receiveFrame(client);
    client.send(
      encode({ t: FrameType.MouseMove, mid: 5, v: 1, ts: 0, p: { x: 0, y: 0 } }),
    );
    const nack = await nackResult;
    await new Promise((r) => setTimeout(r, 0));
    expect(nack.t).toBe(FrameType.Nack);
    expect((nack.p as { reason: string }).reason).toBe("notAuthenticated");
  });

  it("replies to Ping with Pong", async () => {
    client = await connectClient();
    client.send(
      encode({
        t: FrameType.Hello,
        mid: 0,
        v: 1,
        ts: 0,
        p: {
          protoVersion: "1.0",
          clientName: "x",
          clientOs: "android",
          capabilities: [],
          clientTs: 0,
        },
      }),
    );
    await receiveFrame(client);

    const pongPromise = receiveFrame(client);
    client.send(
      encode({ t: FrameType.Ping, mid: 0, v: 1, ts: Date.now(), p: { seq: 7 } }),
    );
    const pong = await pongPromise;
    expect(pong.t).toBe(FrameType.Pong);
    expect((pong.p as { seq: number | null }).seq).toBe(7);
  });

  it("routes an authenticated operational frame and acks it", async () => {
    client = await connectClient();
    client.send(
      encode({
        t: FrameType.Hello,
        mid: 0,
        v: 1,
        ts: 0,
        p: {
          protoVersion: "1.0",
          clientName: "x",
          clientOs: "android",
          capabilities: [],
          clientTs: 0,
        },
      }),
    );
    const helloAck = await receiveFrame(client);
    const sessionId = (helloAck.p as { sessionId: string }).sessionId;

    // Promote the session — normally the app's pairing flow does this.
    const promoted = gateway.authenticate(sessionId, ["keyboard", "mouse"]);
    expect(promoted).toBeTruthy();

    const ackPromise = receiveFrame(client);
    client.send(
      encode({ t: FrameType.MouseMove, mid: 3, v: 1, ts: 0, p: { x: 10, y: 20 } }),
    );
    // The gateway encodes the Ack asynchronously — give it time to land.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const ack = await ackPromise;
    expect(ack.t).toBe(FrameType.Ack);
    expect((ack.p as { mid: number }).mid).toBe(3);
  });

  it("drains sessions with Disconnect on shutdown", async () => {
    client = await connectClient();
    const helloAck = await new Promise<Record<string, unknown>>((resolve) => {
      client.once("message", (d) =>
        resolve(
          msgpackDecode(ownBytes(new Uint8Array(d as ArrayBuffer))) as Record<
            string,
            unknown
          >,
        ),
      );
      client.send(
        encode({
          t: FrameType.Hello,
          mid: 0,
          v: 1,
          ts: 0,
          p: {
            protoVersion: "1.0",
            clientName: "x",
            clientOs: "android",
            capabilities: [],
            clientTs: 0,
          },
        }),
      );
    });
    gateway.authenticate((helloAck.p as { sessionId: string }).sessionId, []);

    const closePromise = new Promise<number>((resolve) => {
      client.once("close", (code) => resolve(code));
    });

    await gateway.stop();
    const code = await closePromise;
    expect(code).toBe(CLOSE_CODES.ServerShutdown);
    expect(gateway.gatewayState).toBe("stopped");
  });
});
