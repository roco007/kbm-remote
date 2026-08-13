# M3 Mouse Subsystem — Task State

## User request

Implement the MOUSE subsystem only (no keyboard/media). Features: absolute + relative movement,
left/right/middle click, drag, scroll, double click, multiple monitor support.
Abstract platform-specific implementations, dependency injection, tests.

## Design decisions (final)

1. No external DI framework (no NestJS bootstrap yet, no inversify dep risk). Use a tiny
   hand-rolled DI container in the receiver app: `packages/input-provider/src/di.ts`
   (Container: registerSingleton/registerValue, resolve) — or simpler: receiver app owns a
   lightweight `Container` module in apps/receiver/src/main/di.ts. DECISION: put `di.ts` in
   apps/receiver (app-level composition root), keep input-provider framework-free.
2. Mouse abstraction: extend InputProvider with mouse-only interface in input-provider package:
   `MouseProvider { name; moveAbsolute(x,y); moveRelative(dx,dy); down/up/click/dblclick(button);
scroll(axis,amount); dragStart/dragMove/dragEnd }` — DECISION: keep InputProvider as-is and add
   dedicated `MouseProvider` interface in input-provider/src/mouse.ts (focused subsystem),
   InputProvider composes MouseProvider + KeyboardProvider + MediaProvider later.
3. Providers (platform abstracted):
   - providers/nutjs.ts — uses @nut-tree-fork/nut-js (mouse.move, mouse.drag, mouse.leftClick etc.)
   - providers/native.ts — platform stubs: win32 SendInput, darwin CGEvent, linux XTest/XDoTool,
     implemented as per-platform modules selected via process.platform at factory time.
   - providers/mock.ts — test spy provider used by tests.
   - factory createMouseProvider() in providers/index.ts picks nutjs (default) / native.
4. Multi-monitor: new module `mouse/monitors.ts` (in input-provider? DECISION: put Monitors API in
   input-provider as monitors.ts: DisplayInfo{displayIndex,scale,geometry(x,y,w,h),primary},
   getDisplays(), pointFromVirtual/normalized coords) + MouseController (apps/receiver? No —
   DECISION: MouseController lives in input-provider package src/controllers/MouseController.ts:
   handles normalized (0..1) absolute moves mapped via current-display geometry, relative moves,
   rate limiting/throttling of move frames, drag state validation). nut.js has .screen &
   mouse.drag — mock provider mimics.
5. Integration with network layer: receiver NetworkService registers MouseMove/Click/Scroll/Drag
   handlers on gateway.frameRouter — but spec said "Implement the mouse subsystem"; wire handlers
   into NetworkService so frames → MouseController. Handlers check session permissions
   (keyboard/mouse scope — permission string "mouse").
6. Tests:
   - packages/input-provider/tests: mouseProvider contract (mock verifies call delegation),
     MouseController (normalized→virtual mapping, boundary clamping, drag state machine,
     double click timing via timeSource, scroll amount clamping), monitors (geometry math),
     native stubs (per-platform selection), rate limiter (throttle moves).
   - apps/receiver/tests: MouseService (NetworkService wiring) — send mouse frames over real
     gateway TLS + ws client, assert provider calls.
7. CI: all gates green incl. new tests; input-provider had package.test.ts placeholder earlier
   (deleted already). vitest + eslint pass.
8. Nut.js API (4.2.6): mouse (instance) .move(new Point), .drag(new Point, left), .leftClick(),
   .rightClick(), .middleClick(), .scrollDown(amount), .scrollUp(amount), .scrollLeft/Right,
   screen.availableMonitors(), Point{x,y}. drag(button, from, to). Button type: { left:'left',...}.
   NOTE: installed version may differ — grep node_modules/@nut-tree-fork/nut-js/dist for API if used.
   IMPORTANT: package declares @nut-tree-fork/nut-js dep — check it's installed; in sandbox maybe not
   (pnpm install). Since we abstract, tests use mock provider; nutjs provider only loaded at runtime.

## Existing facts

- InputProvider interface in packages/input-provider/src/types/index.ts (moveMouse, click, scroll,
  dragStart/Move/End + keyboard/media/command methods). Keep it; add MouseProvider interface new file.
- protocols FrameType: MouseMove 0x40, MouseClick 0x41, MouseScroll 0x42, MouseDragStart 0x43,
  MouseDragMove 0x44, MouseDragEnd 0x45.
- NetworkService at apps/receiver/src/main/networkService.ts: NetworkService options {port, deviceId},
  start()→{port,fingerprint}, sessionCount, gateway.frameRouter.register(type, handler(ctx)),
  gateway.authenticate(sessionId, permissions), auth.verifyAuthenticate; AuthStore; handlers call
  ctx.send({t:FrameType.Ack?,mid:0...}). CLOSE codes in @kbm-remote/network/dist/common:
  NotAuthenticated 4001, IncompatibleVersion 4004, RateLimited 4005.
- Permission scope for mouse: "mouse". verifyAuthenticate returns permissions string[].
- gateway.sendTo needs ws ref — handlers have ctx only; send replies via ctx.send. MouseMove is
  fire-and-forget (mid=0) so no reply needed. MouseClick also mid=0 per spec? Mouse input frames
  are fire-and-forget (spec: input events, ping/pong mid=0).
- receiver tests: connectClient(url,[SUBPROTOCOL],{rejectUnauthorized:false}) via ws; receiveFrame
  helper uses msgpackDecode(ownBytes(data)).

## MouseController contract (decided)

class MouseController(options: {provider, monitors, now?, inputThrottleMs?})
moveAbsolute({x,y}: {x:number,y:number} normalized 0..1, options?) → Promise<void> - looks up target display; clamps; provider.moveAbsolute(virtualX,virtualY)
moveRelative({dx,dy}) → provider.moveRelative
click({button, action:click|dblclick|down|up})
scroll({axis,amount}) with clamp ±15
dragStart({button}) / dragMove({dx,dy} or abs) / dragEnd({button})
moveAbsolute supports {displayIndex?} payload field
Double click: action dblclick → provider dblclick; timeSource injectable for testability.
Input rate limiting: throttles consecutive move frames (default 8ms ≈ 125Hz), drop excess.

## Progress

- [ ] input-provider: mouse.ts interfaces + monitors.ts + MouseController + providers (mock, native, nutjs, factory)
- [ ] input-provider tests
- [ ] receiver: MouseService + DI container (di.ts) + wire into NetworkService handlers + tests
- [ ] CI gates
- [ ] docs/ (append M3a to Networking doc or new docs/Mouse-Subsystem-M3a.md)
- [ ] commit + zip to /mnt/desktop/Remote Emulator/kbm-repo.zip + deliver

## Receiver wiring facts (verified)

- FrameType in packages/protocol/src/types/index.ts: MouseMove 0x40, MouseClick 0x41,
  MouseScroll 0x42, MouseDragStart 0x43, MouseDragMove 0x44, MouseDragEnd 0x45.
- FrameRouter.register(type, handler(frame, ctx) => {ok:true}) — handler gets (f, ctx).
- FrameContext: {sessionId, authenticated, send, close, setSessionId} — NO frame field.
- AuthDecision: {authenticated, permissions: string[], sessionId}; GatewaySession extends it
  - {ws, metrics, missedPongs, connectedAt, lastPongTs}; exported from
    packages/network/src/server/index.ts (type GatewaySession) and network src/index barrel.
- Gateway: gateway.router getter exists (line ~174 returns this.router).
- InputService (apps/receiver/src/main/inputService.ts) WRITTEN: constructor(controller,
  sessionLookup(sessionId)=>GatewaySession|undefined, log?). registerHandlers(router).
  Uses ctx.frame? NO — uses f.p. Permission: ctx.authenticated + sessionLookup.perms incl
  "mouse", else ctx.close(4005). FrameEnvelope imported from @kbm-remote/network? MUST VERIFY
  — FrameEnvelope lives in @kbm-remote/protocol; import in inputService uses @kbm-remote/network — CHECK re-export, else fix.
- input-provider DONE: 33 tests pass, lint/typecheck green. Exports: Container, Token,
  MouseController, MouseProvider, MonitorApi, DisplayInfo, FixedMonitors (test helper),
  MockMouseProvider, DRAG_BUTTONS, SCROLL_CLAMP, DEFAULT_INPUT_THROTTLE_MS, isMouseButton,
  isDragButton, createMouseProvider, monitors: getDisplays(), pointFromNormalized(),
  makeFixedMonitors?, controllers/MouseController options {provider, monitors, now?,
  inputThrottleMs=8}, MouseController methods:
  moveAbsolute({x,y,displayIndex?}), moveRelative({dx,dy}),
  click({button:"left"|"right"|"middle", action:"click"|"dblclick"|"down"|"up"}),
  scroll({axis:"vertical"|"horizontal", amount}), dragStart({button}),
  dragMove({x,y} or {dx,dy}), dragEnd({button}).
- di.ts in input-provider: Token, Container.register(token,factory,lifetime), registerValue,
  resolve; input-provider barrel src/index.ts re-exports all.
- Receiver app: NetworkService at apps/receiver/src/main/networkService.ts; gateway exposed
  as `gateway` (private? check). TODO: create InputModule/composition in receiver main,
  register MouseController in DI (with real createMouseProvider() + monitors), wire
  InputService.registerHandlers(gateway.router); tests for inputService (permission gate,
  delegation to controller, invalid payload) — unit only (mock controller, fake GatewaySession).
- MouseController monitors API: MonitorApi { displays(): Promise<DisplayInfo[]>,
  currentDisplay(): Promise<DisplayInfo>, displayAt(x,y): Promise<DisplayInfo|undefined> } —
  verify exact method names from packages/input-provider/src/mouse.ts if tests need it.

## Receiver wiring progress (verified)

- apps/receiver/src/main/inputService.ts DONE: class InputService(controller,
  sessionLookup(sessionId)=>GatewaySession|undefined, log?). registerHandlers(router) —
  FrameRouter from @kbm-remote/network; FrameType from @kbm-remote/protocol; handler
  signature (f:FrameEnvelope, ctx)=>{ok:true}. Permission: ctx.authenticated && sessionLookup
  perms include MOUSE_PERMISSION="mouse", else ctx.close(4005,"..."). dragMove is absolute-only
  (controller DragMoveInput={x,y,displayIndex?}). click action "click"|"dblclick"|"down"|"up".
- apps/receiver/src/main/inputModule.ts DONE: monitorToken/providerToken/controllerToken,
  ElectronMonitors (electron.screen.getAllDisplays → DisplayInfo; index i, label, primary
  heuristic id===0), createInputContainer(), createInputService(container, sessionLookup).
  createMouseProvider().provider (selection shape). typecheck exit=0.
- MouseController API (verified): MouseControllerOptions {provider, monitors, now?,
  inputThrottleMs?}; moveAbsolute({x,y,displayIndex?}); moveRelative({dx,dy});
  click({button:"left"|"right"|"middle", action:"click"|"dblclick"|"down"|"up"});
  scroll({axis:"vertical"|"horizontal", amount}); dragStart({button}) throws InputError
  "dragNotStarted" if no drag active; dragMove({x,y,displayIndex?}); dragEnd({button}).
  DragMoveInput absolute only. isMouseButton/isDragButton validators exported.
- DisplayInfo: {displayIndex, geometry:{x,y,width,height}, scaleFactor, primary, label}.
- input-provider tsconfig.build.json fixed (rootDir src) — was cause of TS2307.
- TODO: wire inputService into NetworkService (gateway.frameRouter.registerHandlers);
  write receiver inputService unit tests (permission gate, delegation, invalid payloads —
  no TLS needed, mock router); run full CI; docs/ file; commit+zip+deliver.

## Test fixes in progress (apps/receiver/tests/inputService.test.ts)

- File exists; dispatch(session, frame, overrideCtx) now passes ctx through.
- 3 tests pass (unauth gate, permission gate, registers all 6 types). 3 delegation
  tests failing: provider.calls empty — root cause: hasMousePermission uses
  sessionLookup(sessionId) which returns undefined unless dispatch set
  currentSession.sessionId match. dispatch now sets currentSession = session;
  BUT makeCtx(session) builds ctx with session.sessionId — match should hold now.
  Remaining failure: DI container test — ElectronMonitors.getDisplays needs the
  `electron` module; in test env electron.screen undefined → TypeError. The
  DI container test uses createInputContainer() (real) → will fail unless we
  register monitorToken BEFORE creating service OR mock electron. Simplest: in
  the DI test, create a container, register monitorToken with FixedMonitors
  FIRST (before controller resolve... but controller singleton builds lazily at
  resolve — register monitor before container.resolve(controllerToken)). Also
  register providerToken with MockMouseProvider in the DI test.
- Remaining deliverables: 1) fix tests, 2) full monorepo CI (typecheck/lint/test/build), 3) docs/KeyboardMouse-Subsystem-M3.md (protocol types: MouseMove/Click/Scroll/
  DragStart/DragMove/DragEnd; controller API; DI tokens; platform adapters), 4) commit + zip to /mnt/desktop/Remote Emulator/kbm-repo.zip + deliver.

## Debug status (inputService.test.ts)

Handler awaits now; click/scroll/dragStart/dragEnd delegate fine, but moveAbsolute
and dragMove leave provider.calls empty. Both go through
controller.moveAbsolute/dragMove → resolveAbsoluteTarget → monitors.getDisplays.
Hypothesis: resolveAbsoluteTarget throws "noDisplays" or similar because the
FixedMonitors registered via monitorToken is NOT what the resolved controller
received — the controller's options.monitors comes from createInputContainer's
default registration (ElectronMonitors) since register(monitorToken,...) replaces,
BUT controllerToken resolved BEFORE register? Order in beforeEach: createInputContainer
→ register(providerToken, spy) → register(monitorToken, Fixed) → resolve(controllerToken).
Registration order is fine (provider registered before controller resolve).
So controller must have received spy provider (clicks prove it!) but FixedMonitors
may not have been applied — clicks don't need monitors, they pass.
→ provider.calls empty for moves BUT clicks recorded → impossible unless
moveAbsolute calls a DIFFERENT provider instance... or handleMove returns early:
hasMousePermission checks sessionLookup — sessionLookup uses currentSession.
Dispatch sets currentSession=session BEFORE handler call ✓. Session id "sess-1"
matches ctx.sessionId ✓. granted = session.permissions.includes("mouse") ✓.
Hmm — wait: clicks pass, moves fail, dragMoves fail. All go through controller.
Maybe moveAbsolute throws (e.g., pickDisplay error) and handler swallows void.
But then expect empty. Need to console.log the actual error. Next: run single test
with process.on unhandled rejection logging — add a try/catch by temporarily
changing test to await the controller call directly? Simpler: add console.error
in the service log warning capture? The handlers log.warn on rejection? No —
they void the promise, unhandled rejection. Vitest reports the last test though.
Actually the failure report said dragMove got only dragStart+dragEnd — dragEnd
works (no monitors) but dragMoves fail (monitors). STRONG SIGNAL: controller's
monitors is the real ElectronMonitors whose getDisplays crashes
(electron.screen undefined) → dragMove/moveAbsolute throw "Cannot read props of
undefined reading 'getAllDisplays'" → swallowed void promise. Clicks work because
no monitors needed. FIX: controller must get FixedMonitors → the register(monitorToken)
IS being replaced... unless createInputContainer returns a NEW container but the
test creates it then registers — should work. UNLESS: monitorToken imported in
inputModule.ts is re-exported and the test imports a DIFFERENT token instance
(different module resolution path between src and tests)? No, same package.
OR: Container.resolve for monitorToken inside controller factory — factory runs
at controllerToken resolve; registrations map has my FixedMonitors → fine.
WAIT: look at inputModule.ts: createInputContainer may register monitorToken with
`new ElectronMonitors()` and controllerToken with factory using monitorToken.
Test: container = createInputContainer(); container.register(monitorToken,
() => new FixedMonitors(1920,1080)); ← this overrides ✓... BUT the factory
closes over the token, resolves at resolve time ✓. Hmm. One more check: does the
test file import monitorToken from inputModule? Yes. Same token object ✓.
Mystery — add console.log in the test of what controller.options.monitors
instance is (getDisplays result). Actually simplest: just log controller options.

## Debug status 2 (latest)

- Root cause found: `new FixedMonitors(1920, 1080)` — wrong constructor args
  (needs DisplayInfo[]). Fixed to `new FixedMonitors(makeTestDisplays({ secondary: true }))`
  in beforeEach, and added makeTestDisplays to imports.
- Now 5/8 passing. Remaining failures:
  1. move test — provider input includes `displayIndex: 0`; update assertion.
  2. drag test — controller's 8 ms throttle drops the 2nd dragMove (fake timers at t=0);
     advance timers between dragMove dispatches.
  3. DI container test — createInputContainer() with real ElectronMonitors crashes
     (no display server). Fix: register monitorToken with FixedMonitors(makeTestDisplays())
     in that describe block before resolving controller.
- Then: full monorepo CI (typecheck/lint/build/test), docs/Mouse-Subsystem-M3a.md,
  rebuild zip to /mnt/desktop/Remote Emulator/kbm-repo.zip, deliver.
