# M2 Networking Layer — Task State (updated)

## Current request
User asked to implement ONLY the networking layer: WS server, WS client, reconnect, heartbeat, TLS,
auth middleware, message routing, logging. Production quality + unit tests. NO keyboard/mouse logic.

## Context
- User's GitHub: https://github.com/roco007/kbm-remote (user = roco007). GitHub connector attempts declined;
  gh/git push without creds fails. User will pull via their own means OR we push later if connector approved.
  Strategy: implement in sandbox /home/ubuntu/kbm-repo, verify CI gates, then attempt push; inform user how to pull.
- Scaffold lives at /home/ubuntu/kbm-repo. docs/ contains Protocol-Documentation.md = source of truth.

## Build-fix history (repo structure quirk)
- protocol/network tsconfigs had rootDir="." → dist/src/ layout but package.json "main" expects dist/index.js,
  breaking @kbm-remote/protocol resolution. FIX: tsconfig.build.json now overrides "rootDir":"src"
  + "include":["src/**/*.ts"] in BOTH packages (root tsconfig.json keeps rootDir="."); apps tsconfigs unchanged (fine).
- server-side FrameResult renamed to HandlerResult (gatewayTypes.ts); updated frameRouter.ts, authMiddleware.ts,
  server/index.ts. Client FrameResult kept.
- Removed stale packages/network/tests/package.test.ts placeholder (vitest: no test files).
- WssGateway fixes: removed unused AuthMiddleware import; wsModule.WebSocketServer dynamic import +
  `as unknown as ServerOptions` cast; remoteAddress via `_socket`; void-session markers.
- Removed unused SILENCE_WATCHDOG_MS import from ClientConnection.

## Working API surfaces (verified by reading sources)
- protocol src/codec/index.ts: encodeFrame(frame)→Uint8Array; decodeFrame(buf)→{frame, wasCompressed};
  COMPRESSION_THRESHOLD_BYTES=256; PROTOCOL_MAJOR_VERSION=1; CodecError; setCompressor({deflate,inflate}).
  Small frames: c omitted; >256B raw → deflate, c:1, p replaced by {__raw:number[]}.
- protocol src/validation/index.ts: validateEnvelope(any)→FrameEnvelope throws FrameValidationError;
  isValidFrameType.
- network src/monitoring/index.ts: LatencyMetrics: touch(), pingSent(seq), pongReceived(seq), pingReceived(),
  pongSent(), rtt (median), jitter (stdev of 32), lossFraction, quality, samples, reset(), lastActivityAt;
  setClock(fn); constants RTT_ROLLING_WINDOW=32, LOSS_WINDOW_MS=60_000, LATENCY_GOOD_MAX_MS=25,
  LATENCY_POOR_MIN_MS=75.
- network src/common/index.ts: SUBPROTOCOL="kbmremote.v1+msgpack", AUTH_WINDOW_MS=30_000,
  PING_INTERVAL_MS=5_000, SILENCE_WATCHDOG_MS=15_000, MAX_MISSED_PONGS=3, DISCONNECT_ECHO_WAIT_MS=2_000,
  MAX_PING_SEQ_AGE=8, MAX_ACK_ATTEMPTS=4, retryDelay(i)→min(250*2^i,3000)+rand(0,250),
  reconnectDelay(i)→rand(0,min(500*2^i,10_000)), CLOSE_CODES{Normal:1000,NotAuthenticated:4001,
  UnsupportedVersion:4002,Revoked:4003,IncompatibleVersion:4004,RateLimited:4005,ServerShutdown:4006},
  NACK_REASONS[malformed,notAuthenticated,permissionDenied,payloadTooLarge,unknownType], isNackReason.
- network src/client/ClientConnection.ts: ClientConnection(options{url, socketFactory, clientName,
  clientOs:"android"|"ios", capabilities?, resume?, clock?, timerFactory?}). connect(), dispose(),
  send(frame omit mid/v), sendReliable(frame)→Promise<FrameResult>, disconnectGracefully(),
  connectionState "idle|connecting|connected|authenticated|reconnecting|disconnected", sessionId,
  metrics: LatencyMetrics, events{stateChange, helloAck, authOk, authFailed, message(frame),
  reconnecting(attempt), metrics(rtt,jitter,quality)}. Socket interface: readyState, binaryType, onopen,
  onclose({code,reason}), onerror, onmessage({data}), send, close.
- network src/server/WssGateway.ts: WssGateway(options{port, auth:{store, authWindowMs?}, maxFrameBytes?});
  DEFAULT_MAX_FRAME_BYTES=16MB. start(tlsServer:TLSServer) binds "upgrade"; stop() drains w/ Disconnect+2s+4006;
  authenticate(sessionId,permissions)→GatewaySession|null; sessionFor(ws); sendTo(ws,frame);
  public .frameRouter (FrameRouter); gatewayState; sessionCount. Watchdog: 7.5s interval, idle>15s→4001,
  missedPongs>3→4001, RTT>75→warn.
- network src/server/frameRouter.ts: FrameRouter.register(type,handler), .has, .route(frame,ctx)→RouteOutcome
  {kind:"ack"|"nack"|"fatal", frame, ...}; FrameContext{sessionId, authenticated, send, close};
  PRE_AUTH_TYPES={Hello,PairRequest,PairResponse,Authenticate}; handler:(frame,ctx)=>Promise<HandlerResult>;
  handlerSuccess(); FrameHandlerError; version gate v!==1 → fatal 4004.
- network src/server/authMiddleware.ts: AuthMiddleware(deps{store, authWindowMs?}); isAuthWindowExpired(openedAt);
  verifyAuthenticate(sessionId,token)→{ok,permissions}|{ok:false,reason:"invalid"}; static authFailed().
  AuthStore{verifyToken, storeSession, revokeSession, isRateLimited, recordPairingAttempt}; AuthDecision.
- network src/logging/index.ts: Logger(context) .info/.warn/.error(msg, meta).
- network src/transport/tls.ts: TLS helpers (cert gen, fingerprint) — Node-only.

## Remaining plan
1. Protocol codec: DONE. 2. Network core: DONE. 3. Wire into apps (minimal stubs w/ TODO): next.
4. Tests: protocol/tests/codec.test.ts written (NOTE: its rawDeflate stub is unused placeholder — verify
  it doesn't execute; compressor injection test re-sets backend). STILL NEED network tests:
  monitoring (LatencyMetrics), common (retry/reconnect bounds), client (fake socket: HelloAck, Ping/Pong,
  Ack/Nack, retry exhaust, reconnect backoff, dispose, disconnectGracefully), server (frameRouter gate/
  outcomes, authMiddleware token verify/revoke/rate-limit, WssGateway e2e w/ Node ws client + fake TLS
  server).
5. CI gates pass (build/typecheck/lint/format/test); format with prettier --write where needed.
6. Push to GitHub (try gh; else zip + instructions), write docs/M2-networking guide, summary message.

## CI verification commands
- pnpm turbo build|typecheck|lint|test --force (root); pnpm format / pnpm format:check
- husky pre-commit: lint-staged; .github/workflows/ci.yml

## Progress update (latest)
- protocol tests DONE: tests/codec.test.ts (15 tests pass incl. codec round-trip, threshold boundary at n=247,
  compressor injection, validation). Protocol package typecheck+test GREEN.
- network tests written (NOT yet verified): tests/monitoring.test.ts (LatencyMetrics: rtt/quality/jitter/
  window/loss/watchdog-touch/reset), tests/common.test.ts (constants pinning retry/reconnect/close codes/
  nack reasons), tests/client.test.ts (ClientConnection w/ FakeSocket harness + fake timers: HelloAck,
  ping loop RTT, missed pong reconnect, reliable ack, retry exhaust 5×tick(3500), revoke→no reconnect,
  disconnectGracefully 2s, dispose).
- REMAINING: verify network tests pass (may need FrameType values: 0x01=Hello? VERIFY actual values in
  packages/protocol/src/types/index.ts — client.test.ts hardcodes 0x01 Hello, 0x02 HelloAck, 0x03 Ping,
  0x04 Pong, 0x14=20 Ack, 0x12=18 Disconnect, 0x20=32 ClipboardQuery — CHECK against FrameType enum!).
  Fix clock.tick logic (tick() fires at most one timeout per call — retries use setTimeout w/ delay
  retryDelay(0)=250..500, retryDelay(1)=500..750, retryDelay(2)=1000..1250, retryDelay(3)=2000..2250;
  5×tick(3500) may fire only one per call → may need multiple ticks or loop until pending resolves).
- Then: wire apps stubs (minimal TODO comments in apps/receiver + apps/sender), CI gates, push, docs, summary.

## Progress update 2
- client.test.ts rewritten cleanly (FrameType enum, FakeTimers.tick fires all due timeouts in a loop,
  handshake() helper, resume-id test, retry-exhaust loop ticks 4s rounds until resolved).
- server.test.ts written: FrameRouter (auth gate, pre-auth 4 types, unknown type nack, version fatal,
  handler refusal/FrameHandlerError mapping), AuthMiddleware (verify ok/invalid/revoked, 30s window,
  authFailed), WssGateway e2e (subprotocol rejection, Hello handshake sessionId, pre-auth nack,
  Ping/Pong, authenticated route + Ack, shutdown drain close 4006). Uses Node http server + ws client.
- NEXT: run pnpm turbo test --force from repo root; fix failures; then app wiring stubs; CI; push; docs.
- FrameType values: Hello 0x01, HelloAck 0x02, Ping 0x20, Pong 0x21, Ack 0x30, ClipboardSync 0x70,
  ClipboardQuery 0x71, Disconnect 0xd0, MouseMove 0x05? (verify if needed — used only as router key).

## Test failure root causes (run 1)
1. client/server tests: @msgpack/msgpack not a dependency of network package → add "devDependencies":
   {"@msgpack/msgpack": "^3.0.1"} to packages/network/package.json (also need @kbm-remote/protocol as
   devDependency? it's already a dependency). pnpm install after.
2. monitoring test: RTT median of [12,60,100] = 60 → "degraded" (60 <= 75), not "poor". Fix assertion:
   quality === "degraded". (Also jitter test: pongReceived uses nowMs at pong arrival but clock advanced
   with setClock — jitter computed 0 because pongReceived records rtt correctly... but expected 11.18
   with rtts [10,20,30,40] → stddev=11.18; received 0. Cause: pingSent records nowMs() at time of ping,
   pongReceived rtt = nowMs()-sendAt — with default now, ok. BUT the test ran right after setClock test
   that restored Date.now... jitter=0 suggests only 1 sample? No — rtt values: pingSent(i) at t=0? now
   is Date.now; all 4 pings at same nowMs → rtt=0 each. Fix: setClock + advance now per sample in jitter test.)
3. quality band test: keep simple — good<25, degraded 25-75, poor>75; median exactly 60 → degraded.

## Key findings from source re-read (fixes needed)
1. WssGateway has NO built-in Hello/HelloAck handler — Hello goes through router; if no handler
   registered → nack unknownType. Server tests must register a Hello handler that replies HelloAck
   with a generated sessionId (or use FrameHandler that composes sendTo pattern via ctx.send).
2. ACK flow in gateway: applyOutcome sends Ack ONLY when frame.mid>0. My handler for MouseMove sent its
   own Ack manually → client saw two acks, but error was 49 vs 48: FrameType.Ack=48 vs Nack=49; my
   handler sent {t:Ack, mid:0, p:{mid:1}} but the routed frame had mid=3 and handler read mid 1...
   Actually the ack mismatch "expected 49 to be 48" means ack.t===49 (Nack) — because the MouseMove
   handler was registered in makeGateway via gateway.frameRouter.register BEFORE start() — fine,
   BUT applyOutcome auto-sends Ack for mid>0 and my handler ALSO sent an Ack → client got 2 msgs;
   receiveFrame reads the FIRST (auto Ack mid:3) → t=48? No wait: expected 48 (Ack), received 49 (Nack).
   Root cause: my handler throws because it calls ctx.send synchronously after await router.route?
   Simpler fix: my registered handler uses sendTo async; the auto-Ack uses frame.mid; the manual one
   used p.mid=1 instead of 3 — client read first message which is manual Ack? Order: route() completes
   handler (sends manual Ack mid:1), then applyOutcome sends auto Ack mid:3. Client receives manual
   first: t=48 (Ack) mid=1, then auto t=48 mid=3 → expect ack.t = 48 passes, p.mid=1 ≠ 3 FAILS.
   But error shows ack.t=49... so client actually received a Nack: probably because hello handshake
   never succeeded → session transient + no authenticate call → pre-auth gate → nack. Indeed
   `nacks operational frames before authentication` test registered NO Hello handler → gateway would
   send HelloAck only if handler registered. All server e2e tests share this problem: need Hello handler.
3. Client test failures:
   - "includes resume session id": decode(socket.sent[0]) → sent[0] undefined → socketFactory runs inside
     conn.connect which is async; handshake test passes because connectPromise resolves after onopen;
     but in resume test I call `void conn.connect()` then socket = new... socketFactory is async-safe;
     socket.sent[0] decode undefined: means connect() hasn't created socket yet (await not used).
     Fix: await conn.connect() or just `await new Promise(r=>setTimeout(r,0))`.
   - "sends Ping every 5 s": expected sent length 2 got 1 → timers.tick(5000) fired intervals but
     my FakeTimers.tick uses `while(fired)` loop — interval handler schedules no timeouts; the ping
     is sent by setInterval handler itself, fine. BUT ClientConnection's ping loop may use timerFactory.setTimeout
     for ping loop... sent length 1 = only Hello. Likely because interval entry was CLEARED? Actually
     client creates ping loop via setInterval — entry.handler called, sends Ping → sent should be 2.
     Wait — the failing assertion at line 199: `expect(socket.sent.length).toBe(pingCountBefore+1)`
     expected 2 got 1. So handler didn't fire: pingLoop registered interval before handshake? No —
     ping loop starts in HelloAck handler (async handleMessage via await import decode). socket.receive
     calls onmessage synchronously; handleMessage async → await import("@kbm-remote/protocol") promise;
     in test the next line timers.tick() runs synchronously BEFORE the async chain resolves!
     Fix: await new Promise(r=>setTimeout(r,0)) after receive to let async handleMessage settle before tick.
4. Server e2e: "rejects connections without negotiated subprotocol" timed out 2024ms — ws client with
   bogus subprotocol on a 400 response: ws library throws error immediately (expect via 'error'),
   my code uses once("open")/once("error") — error fires → reject → timeout via setTimeout? No,
   reject happens; connectClient promise rejects... but test awaits it and expects resolution →
   2s timeout from receiveFrame? No — test body awaits connectClient (should reject fast). Actually
   error handler: ws emits error before promise is observed? It resolves in try... The 2024ms is
   receiveFrame's 2s timeout. Probably gateway.start(httpServer as TLSServer) — the "upgrade" event
   works on plain http server too (it's a net event on http.Server)... so upgrade handler ran, wrote
   400, destroyed socket; client onerror → promise rejected → test awaited inside... but error
   rejection makes test throw earlier than 2s. Hmm — maybe error event not emitted (400 + destroy
   causes 'unexpected server response' which IS an error). Timeout suggests receiveFrame awaited —
   meaning connectClient resolved! ws with bad subprotocol still opens (server didn't send 400
   because upgrade handling order?). Actually: http server's 'upgrade' listener must be added BEFORE
   ws server handles upgrade — it is. But gateway.start binds listener; order ok.
   Likely issue: `await gateway.start(httpServer as unknown as TLSServer)` — start is async; inside,
   `await import("ws")` then new WebSocketServer. Fine. But httpServer.listen + start are concurrent:
   beforeEach calls await gateway.start after listen — ok.
   Real bug: receiveFrame timeout 2000ms — so connectClient DID resolve (socket opened), meaning the
   400 write + destroy didn't prevent the client handshake completing (node ws opens on non-101? it
   errors). Then receiveFrame awaited 2s with no message → 400 write happened but client still got
   a 101?? No — ws client with 'plain' protocol: client sends header Sec-WebSocket-Protocol: plain;
   server writes 400 → onerror 'unexpected server response' → client emits error → open never fires.
   But test passed 'open'? The 2s timeout is in receiveFrame called AFTER... wait test:
   const ws = await new Promise(resolve/reject)... then await new Promise(r=>setTimeout(r,50)) then
   expect(sessionCount) — the 2024ms points at receiveFrame not present in this test... the failure
   trace earlier showed line numbers w/ receiveFrame — so error came from connectClient await with
   setTimeout rejection. Fix: handle error by resolving with null and closing.

## Root causes found + fixes applied (test debug session)
- sendFrame/sendTo in both client + gateway encode asynchronously (dynamic import("@kbm-remote/protocol")
  → encodeFrame) → all sends are async; tests must await settle after tick()/send calls. Applied in
  client.test.ts (6 edits). Server e2e also needs settles after send() for mousemove + after handshake sends.
- gateway has NO Hello handler — server tests must register Hello handler sending HelloAck w/ sessionId.
  Done in makeGateway.
- Subprotocol rejection test: expect ws error not open. Fixed (expect error truthy).
- ACK auto-send: gateway applyOutcome sends Ack for mid>0; my MouseMove handler no longer sends manual Ack
  (client reads single auto-Ack mid:3).
- Retry-exhaust test: loop ticks 4s rounds until resolved (works with async encoding; may need more rounds).
- Still failing: 'routes an authenticated operational frame and acks it' timed out 2014ms — likely
  receiveFrame client-side awaited HelloAck fine, but after authenticate() call the MouseMove send/receive
  chain not settled, or gateway session lookup fails because gateway.authenticate(sessionId) matches
  transient→sessionId from HelloAck? It does (session.sessionId set in Hello handler... wait: Hello
  handler in tests sets sessionId via ctx.send only — does NOT set session.sessionId in GatewaySession!
  The gateway's session.sessionId stays transient-*. So gateway.authenticate(helloAck sessionId)
  returns null and session stays unauthenticated → route returns nack → client sees Nack → receiveFrame
  resolves with t=49 (Nack) → expect ack.t=48 fails → that was the 48 vs 49 error!
  FIX: Hello handler must also call a gateway method to set session id, or gateway must derive session
  id from HelloAck payload. Better: add gateway.updateSessionId(ws, sessionId) or have Hello handler
  receive a callback. Simplest: add `setSessionId(ws, id)` public method; test calls it inside handler?
  The handler doesn't have ws ref. Alternative: gateway routes Hello with ctx — extend ctx with
  `setSessionId(id)`; gateway.applyOutcome/onMessage sets it on ack. CLEANEST: add optional ctx.setSessionId
  to FrameContext (server side) — but FrameContext is part of frameRouter API; adding field is fine
  (optional). Then Hello handler calls ctx.setSessionId?.(id) and gateway passes it to onMessage ctx.
  Also update gateway so session.sessionId is set on HelloAck reply (same).
- After Hello handler sets sessionId, authenticate() finds session → authenticated=true → MouseMove acked.

## Probe findings (ping test)
- "PROBE sent: 1 [1] intervals: 0" → ping loop interval got CLEARED. clearPingTimer called at:
  dispose (L151), onSocketClose (L340), startPingLoop-first (L379, that's before set, fine).
- Hypothesis: my tick() fires interval handlers AND timeouts in a while loop — the ping loop handler
  runs, missedPongs becomes 1, then the loop continues firing TIMEOUTS... none due. Fine. But WHY
  cleared? Another theory: helloAuth timeout setTimeout(30s) — no clear of intervals.
- REAL issue candidate: my tick() after handshake fires BOTH the ping interval AND the 30s auth-window
  setTimeout check? dueAt=0+30000, tick adds 5000 → 30000 not due. No.
- REAL issue: startPingLoop clears then sets — fine. But `clearPingTimer` is called in onSocketClose.
  Is onSocketClose firing? When does socket close? missedPongs>3 after 4 ticks — only 1 tick.
  Wait — look at sendFrame: if socket.readyState!==1 drops. Probe shows sent only [1]=Hello. So ping
  never even ENCODED — interval handler never ran (intervals:0 means cleared OR interval entry cleared).
- Entry.clear() called where: clearPingTimer via clearInterval default (not our fake), dispose,
  onSocketClose. socketFactory fake socket never closes. BUT: openSocket() — check it!

## Phase 2 progress — app wiring (2026-08-12)
All CI gates green: typecheck/lint/format/test — 46 network tests, 12 turbo tasks successful. .prettierignore now ignores TASK-STATE-M2.md.

### App wiring facts (verified via grep, no need to re-verify):
- WssGateway constructor options: { port, auth: { store: AuthStore, authWindowMs? }, maxFrameBytes? }. `gateway.start(tlsServer)` — app supplies TLSServer (app creates tls.createServer with self-signed cert from @kbm-remote/network transport/tls generateSelfSignedCert + fingerprintOf).
- `gateway.frameRouter` (FrameRouter) — app registers handlers via `gateway.frameRouter.register(FrameType, async (frame, ctx) => {...})`. ctx has { sessionId, authenticated, send(frame), close(), setSessionId?. }
- `gateway.authenticate(sessionId, permissions[])` promotes session — called by app auth handler after verifying token.
- AuthStore iface (authMiddleware.ts): verifyToken(sessionId,token)=>permissions[]|null; storeSession; revokeSession; isRateLimited; recordPairingAttempt. AuthMiddleware used by tests; gateway does NOT auto-wire AuthMiddleware — app must register Authenticate handler that calls auth middleware (or implement directly).
- gateway.sendTo(ws, frame), gateway.sessionFor(ws), sessionCount, gatewayState.
- ClientConnection options: { url, socketFactory(url,protocols)=>ClientSocket, clientName, clientOs:"android"|"ios", capabilities?, resume:{sessionId,sessionToken}, clock?, timerFactory? }.
- ClientConnection.events = { stateChange, helloAck, authOk, authFailed, message, reconnecting } (optional callbacks). sessionId field set after HelloAck.
- send(frame) fire-and-forget (mid=0); sendReliable(frame) returns Promise<FrameResult>. disconnectGracefully(). dispose().
- ClientSocket iface: readyState, binaryType, onopen/onclose/onerror/onmessage, send(ArrayBuffer|Uint8Array|string), close(code?,reason?).
- receiver app deps already include @kbm-remote/network, protocol; NestJS + express/socket.io in package.json (gateway uses bare `ws` — keep socket.io for future; gateway binds on raw tls.Server upgrade, works independently).
- sender app is Expo RN; socketFactory for Node: `ws` WebSocket; for RN: native WS.
- apps/receiver/src/main/index.ts = empty async main() stub; apps/sender/src/services/connectionManager.ts = placeholder export.

### Wiring plan
1. receiver/src/main/networkService.ts: NetworkService class wrapping WssGateway + TLS cert generation + register Hello/Authenticate handlers + AuthStore in-memory (device registry) placeholder for M1; wire into Nest-ish bootstrap (just plain service used by main/index.ts, documented).
2. receiver/src/main/index.ts: create TLS server with self-signed cert, start gateway, tray/lifecycle comments.
3. sender/src/services/connectionManager.ts: ConnectionManager wrapping ClientConnection with ws socketFactory (node) / note RN factory; expose connect/disconnect, session persistence resume, events.
4. Add tests for both (receiver NetworkService unit, sender ConnectionManager with fake factory).
5. Docs: docs/Networking-Implementation-M2.md (or update Protocol doc).
6. Push to github roco007/kbm-remote (credentials may fail; fallback: copy to /mnt/desktop/... Remote Emulator mount at /mnt/desktop/Remote Emulator).

### Remaining
- [ ] Wire receiver gateway
- [ ] Wire sender connection manager
- [ ] App-level tests
- [ ] M2 doc
- [ ] Transfer to Mac/GitHub

## Phase 2 update (post-compaction recovery)
DONE: apps/receiver/src/main/networkService.ts created (NetworkService: TLS identity via dynamic import @kbm-remote/network/dist/src/transport/tls.js, gateway.start(tlsServer), registers Hello + Authenticate handlers on gateway.frameRouter, in-memory AuthStore). apps/sender/src/services/connectionManager.ts rewritten (ConnectionManager with typed Emitter, setUrl, connect/disconnect/dispose). ClientConnection.setUrl(url) added in packages/network/src/client/ClientConnection.ts (after constructor private options).
Emitter pattern: listeners Map<keyof E, Set<(...args:any[])=>void>>, emit uses listener(...args) directly.

REMAINING CHECKS:
1. pnpm typecheck from repo root (receiver + sender + network). network build must be run (turbo build --filter=@kbm-remote/network) before sender typecheck due to tsconfig project references.
2. Add unit tests: apps/receiver/tests/networkService.test.ts (fake TLS server + fake ws client end-to-end, similar pattern as packages/network/tests/server.test.ts: createServer http, gateway.start(httpServer as never), ws client with subprotocol "kbm-remote/1.0"? check SUBPROTOCOL const value — it's in packages/network/src/common), test Hello → HelloAck with sessionId, Authenticate with valid/invalid token.
3. Add apps/sender tests/connectionManager.test.ts (fake socketFactory).
4. Lint+format fix for new files.
5. M2 documentation: docs/Networking-Implementation-M2.md (new) or section; cover: packages (protocol codec/validation, network server/client/monitoring/tls), app wiring (NetworkService, ConnectionManager), test strategy, how to run, latency/security guarantees.
6. Push to https://github.com/roco007/kbm-remote (git remote likely configured; user GitHub collaborator access accepted earlier). Fallback: copy zip to /mnt/desktop/Remote Emulator/.
7. Deliver final message.

Key constants: SUBPROTOCOL value = check common.ts ("kbm-remote/1.0"?). CLOSE codes: Normal 1000, NotAuthenticated 4001, Revoked 4002, IncompatibleVersion 4004. PING_INTERVAL_MS=5000. PORT default 27001.
FrameType enum values: Hello 0x01, HelloAck 0x02, Authenticate 0x03, AuthOk 0x04, AuthFailed 0x05, Ping 0x20, Pong 0x21.
AuthMiddleware API: new AuthMiddleware({store, authWindowMs}), verifyAuthenticate(sessionId, token)=>{ok,permissions}|{ok:false,reason:'invalid'|'revoked'}.
gateway: new WssGateway({port, auth:{store, authWindowMs}, maxFrameBytes}), start(tlsServer), stop(), frameRouter (FrameRouter.register(type, async(frame,ctx)=>({ok:true}|{ok:false,reason:'malformed'|'notAuthenticated'|'permissionDenied'|'payloadTooLarge'|'unknownType'}))), sessionCount, authenticate(sessionId,permissions), sessionFor(ws), sendTo(ws,frame).
ctx: sessionId, authenticated, send(frame full envelope incl mid/v/ts), close(code,reason), setSessionId?.
ClientConnection: new ClientConnection({url, socketFactory, clientName, clientOs, capabilities?, resume:{sessionId,sessionToken}, clock?, timerFactory?}), events={stateChange, helloAck, authOk, authFailed, message, reconnecting}, sessionId, connectionState, setUrl, connect(), disconnectGracefully(), dispose(), send(frame w/o mid/v), sendReliable => Promise<{ok}|{ok:false,reason}>, metrics (LatencyMetrics: rtt, quality, jitter).
Tests infrastructure lessons: FakeTimers tick must fire each interval once + drain timeouts; msgpack pooled buffers need ownBytes() slice (buffer.slice(byteOffset, byteOffset+length)); fix metrics clock with setClock(()=>timers.value); handshake needs await Promise(setTimeout(0)) x2 after onopen; gateway e2e tests must register Hello handler calling ctx.setSessionId.
Server test pattern (server.test.ts line ~267): const httpServer = createServer(); await gateway.start(httpServer as never); ws client via new WebSocket(`ws://127.0.0.1:${port}`, [SUBPROTOCOL]).

## State update — app tests phase
DONE: apps wired (NetworkService, ConnectionManager, ClientConnection.setUrl), both apps typecheck+lint pass, turbo typecheck 12/12 successful. Added ws + @msgpack/msgpack devDeps to apps/sender+receiver package.json (script scripts/add-test-deps.js). Wrote tests: apps/receiver/tests/networkService.test.ts (e2e: start service, Hello→HelloAck sessionId, wrong subprotocol reject, version 99 close 4004, AuthOk/AuthFailed flow, invalid token close 4001) and apps/sender/tests/connectionManager.test.ts (fake receiver via ws server, states, sessionId fake-session, resume, dispose error, setUrl, message event).

REMAINING:
1. Fix import paths in receiver test: it imports `@kbm-remote/network/dist/src/common` — prefer relative? Actually network package dist build puts common.js at dist/src/common.js (build rootDir=src) so `@kbm-remote/network/dist/src/common` resolves via package main? network package.json main is dist/index.js — importing `@kbm-remote/network/dist/src/common` works because it's a file path under the package (subpath resolution). VERIFY it works; alternatives: relative import `../../../packages/network/src/common`. Also receiver test imports `../src/main/networkService` (correct).
2. Sender test: `import { ConnectionManager, type ClientSocket } from "../src/services/connectionManager"` — ClientSocket is NOT exported from connectionManager.ts! Add export or use ClientSocket from @kbm-remote/network directly in the test.
3. Sender FakeReceiver uses require("ws") dynamic import — fine. Uses JSON.stringify for frames — the real gateway decodes msgpack binary; ClientConnection sends Uint8Array msgpack. FakeReceiver decodes with await import("@kbm-remote/protocol").decodeFrame which expects ArrayBuffer — but `data` from ws is Buffer by default in Node. decodeFrame handles ArrayBuffer — Buffer IS an ArrayBufferView... decodeFrame implementation checks instanceof ArrayBuffer? Check codec decodeFrame shape. If it rejects Buffer, convert data to ArrayBuffer.
4. ClientConnection events.message signature — test expects inbound frame delivered to client events.message — ClientConnection emits it via handleMessage for data frames. The fake sends HelloAck (meta: handled internally) then test sends MouseMove frame via socket.onmessage. OK but decodeFrame may need ArrayBuffer not string — the sender app client sends msgpack binary; fake delivers JSON string — decodeFrame on JSON string will fail (expects binary). Fix FakeReceiver in test? No — the inbound frame in sender test is delivered directly via socket.onmessage with string — decodeFrame would fail. Better: deliver raw msgpack-encoded bytes of the MouseMove envelope (use msgpackEncode), AND FakeReceiver's HelloAck should be msgpack binary too (encode with encodeFrame). Since protocol is in monorepo, use encodeFrame from @kbm-remote/protocol in both fakes.
5. Also client.onmessage handler in ClientConnection: signature expects {data: ArrayBuffer|string} — passes Buffer? ws in node gives Buffer. decodeFrame likely accepts Buffer as ArrayBufferView. Test works if using msgpack bytes.
6. After tests pass: run pnpm turbo test --force (12 tasks), lint --fix, format.
7. Docs: docs/Networking-Implementation-M2.md. Outline: overview, package layout table (protocol/src/codec, protocol/src/validation, network/src/server [WssGateway, frameRouter, authMiddleware, gatewayTypes], network/src/client [ClientConnection], network/src/monitoring [LatencyMetrics], network/src/transport [tls], network/src/common, network/src/logging), wire protocol recap (msgpack frames, compression, heartbeat, ack/retry, backoff), app wiring (NetworkService on receiver, ConnectionManager on sender), test strategy, run commands, guarantees table.
8. Push: git add -A && git commit "feat(network): implement secure networking layer (M2)" && git push origin HEAD (branch? check git branch). If push fails (auth), try GitHub CLI `gh auth login` or copy zip to /mnt/desktop/Remote Emulator/ folder on user's Mac. User repo: https://github.com/roco007/kbm-remote. Earlier sessions: user accepted collaborator request; push may need token — check `git remote -v` and existing git config credential helper.
9. Final delivery message with summary.

## State update — sender message-event test still failing
Root cause hypothesis (not yet confirmed): the ConnectionManager test's "emits the message event" gets received.length === 0 even though the fake echoes a MouseMove frame. Manager events.message listener IS registered before connect.

Key facts:
- ClientConnection.handleMessage switch default branch emits this.events.message?.(frame) — so ANY unknown-type frame (MouseMove) should emit.
- FakeReceiver: new connection → Hello → HelloAck; then non-Hello frames echoed as raw Buffer (ws.send(data) sends binary).
- FakeReceiver is shared: the SECOND ws (test client) connects, sends Hello, receives HelloAck; then sends MouseMove → fake echoes. The MANAGER's socket should receive that echo? NO — wrong socket! The echoed MouseMove goes to the SECOND ws (which sent it), not the manager's socket. The manager's events.message would only fire for frames delivered to the manager's own socket.
- FIX for test: deliver the MouseMove echo via the MANAGER's underlying socket — the simplest way is to have FakeReceiver echo non-Hello frames back to the socket that sent them (it does), so the sender-side manager WILL receive them only if the sender sent them. In production the RECEIVER sends frames to the sender. So correct test: manager connects (its socket on fake receiver A), then from INSIDE the manager's socket handler? Actually the fake must simulate the receiver: when manager sends frames, receiver can respond with MouseMove frames addressed to sender (the manager). Simplest test fix: have FakeReceiver, after receiving Hello from manager's connection, push one MouseMove frame back to THAT connection after 50ms.
- Test fix plan: add FakeReceiver option to push inbound frames to the session after Hello; or simpler: make the fake send a MouseMove to the manager connection in response to Hello.

Receiver app test status: not yet run (had type errors: ws types missing, implicit any for `data`/`code` params, `.p` casting on empty obj). FIXES needed in apps/receiver/tests/networkService.test.ts:
1. Add import type { MessageEvent } from 'ws' or just type the receiveFrame callback: ws.once("message", (data: Buffer) => ...).
2. Line 101: `const ack = await receiveFrame(ws); ... (ack.p as { receiverName?: string })` — the cast on empty `{}` fails; declare receiveFrame return type `Promise<Record<string, unknown>>` (already) but `ack.p` typed as `{}` because msgpackDecode returns unknown → cast `const ack = ...(as Record<string,unknown>)`; and `(ack.p as ...)`. Actually error says Property 'sessionId' does not exist on type '{}' — so cast wasn't applied. Ensure cast: `const ack = (await receiveFrame(ws)) as Record<string, unknown>;` (msgpackDecode → unknown; helper already typed Record<string,unknown>?). The error at 101:30 ack.p?.sessionId — likely msgpackDecode return is unknown, helper generic. Fix by annotating helper return as `Promise<Record<string, unknown>>` explicitly via `as Record<string, unknown>` at call site.
3. Line 65: `(data)` param implicit any — type `data: Buffer`.
4. Lines 122/195: close event `(code)` — `ws.once("close", (code: number) => resolve(code))`.
5. @types/ws added to both apps — reinstall done.

REMAINING overall:
1. Fix sender message test (fake pushes MouseMove to manager's connection after Hello).
2. Fix receiver test type errors, run receiver tests.
3. Full turbo test + lint + format.
4. Docs docs/Networking-Implementation-M2.md.
5. Push to GitHub https://github.com/roco007/kbm-remote (git remote configured; if auth fails try `git push` after checking credential helper, or zip to /mnt/desktop/Remote Emulator/).
6. Final delivery.

## FINAL STATUS (as of latest)
- ALL CI GATES GREEN:
  - pnpm turbo typecheck --force: OK
  - pnpm turbo lint --force: OK (after fixes below)
  - pnpm turbo test --force: network 46, protocol 15, receiver 8, sender 8, auth 1, input-provider 1, ui-components 2 — all pass
  - pnpm turbo build --force: OK
- Receiver tests (8/8): handshake HelloAck/HelloAck+Ack(mid), subprotocol rejection, version 4004,
  AuthOk/AuthFailed promotion (with flush-before-close fix), 4001 close on invalid token.
- Sender tests (8/8): connection manager transitions, resume Hello, authRequired=false,
  inbound message events, reconnect, graceful disconnect, dispose — pass via vitest.

## Lint fixes applied
- packages/network/tests/client.test.ts: require → import msgpackDecode (no-var-requires).
- apps/sender/tests/connectionManager.test.ts: removed unused msgpack imports, fixed ErrorEvent cast
  (ev as {message?:string}|null), fakeSocket __bind via (fakeSocket as unknown as {...}).
- apps/sender/src/services/connectionManager.ts: reordered imports (@kbm-remote/protocol before network),
  removed empty line at 21.
- apps/receiver/tests/networkService.test.ts: prettier/eslint --fix (import order).
- apps/receiver/tests/networkService.test.ts: 'promotes a session' now expects Ack frame first
  (p.mid=2 is the Authenticate reply's own Ack? actually Hello's Ack mid=1 arrives with HelloAck order
  race → test now reads: first frame must be Ack, second must be AuthOk/AuthFailed).

## Key architectural fixes made this session
1. selfsigned npm replaces hand-rolled DER cert builder in packages/network/src/transport/tls.ts
   (generateSelfSignedCert async).
2. apps/receiver/src/main/networkService.ts uses node:https.createServer({key,cert}) — plain node:tls
   server doesn't emit 'upgrade', so ws library never saw connections.
3. packages/network/src/server/WssGateway.ts: attaches ws.WebSocketServer via `server:` option with
   verifyClient callback-style subprotocol check; wireServer(connection listener); address getter;
   configuredPort; host app binds port; sendTo tracks pendingSends; close() flushes pending sends
   (1s guard) before emitting close — fixes AuthOk/AuthFailed frames dropped by sync close.

## Remaining
1. Write docs/Networking-Implementation-M2.md (implementation guide, API surface, test matrix,
   troubleshooting — use content in this file as source).
2. Commit all M2 changes and push to https://github.com/roco007/kbm-remote (gh auth may be configured
   now — user earlier said 'request accepted' — try `git push`; fallback: zip on desktop mount at
   /mnt/desktop/Remote Emulator/kbm-repo.zip exists but is STALE — recreate fresh zip there too).
3. Deliver final summary to user.
