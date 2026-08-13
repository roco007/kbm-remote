# Milestone 3a — Mouse Subsystem

**Author:** Manus AI · **Status:** Implemented and CI-verified · **Companion docs:** [04 Networking Implementation M2](./Networking-Implementation-M2.md), [Protocol Documentation](./Protocol-Documentation.md)

## 1. Overview and Scope

The mouse subsystem is the receiver-side implementation of Milestone 3a: it turns the six mouse frame types defined in the binary protocol (§4.3 of the Protocol Documentation) into real, low-latency pointer input on the receiver's operating system. It covers absolute movement, relative movement, left/right/middle clicks, double click, button down/up, vertical and horizontal scrolling, the full drag state machine (start/move/end), and multi-monitor support with differing resolutions and scale factors.

The subsystem was built to the same standard as Milestone 2's networking layer: a provider-agnostic core with no direct dependency on any input library, thin platform adapters behind a single interface, a composition root with dependency injection, and a test suite that exercises the whole path from protocol frame to provider call without needing an OS display server. All 16 receiver tests and 33 input-provider tests pass, and the full monorepo CI (typecheck, lint, build, test across 12 tasks) is green.

## 2. Architecture

The subsystem spans two layers of the monorepo. The provider-agnostic core lives in `packages/input-provider`, which is deliberately framework-free so it can later be reused by a server or CLI build of the receiver. The receiver-side wiring — the `InputModule` composition root and the permission-gated `InputService` that attaches to the network gateway — lives in `apps/receiver`.

```
Protocol frame (WSS)                     Dependency graph
┌────────────────────┐          ┌─────────────────────────────────────────┐
│  Gateway session   │          │  inputModule (composition root)         │
│  + permission gate │          │                                         │
│        ▼           │          │  ┌──────────────┐                       │
│  InputService      │───▶─────│──│  MouseController                      │
│  (registerHandlers)│          │  │  (normalized  │      ┌──────────┐   │
└────────────────────┘          │  │   → virtual   │─────▶│MouseProvider│   │
                                │  │   coords,     │      │ (adapter) │   │
                                │  │   throttle,   │      │┌─────────┐│   │
                                │  │   drag state) │      ││ nutjs    ││   │
                                │  └──────┬────────┘      ││ native   ││   │
                                │         │               ││ mock     ││   │
                                │         ▼               │└─────────┘│   │
                                │  MonitorApi             │  factory:  │   │
                                │  (display layout)       │  nutjs →   │   │
                                │  ┌─────────────────┐    │  native →  │   │
                                │  │ ElectronMonitors│    │  mock      │   │
                                │  │ (test: FixedMonitors)│            │   │
                                │  └─────────────────┘    └───────────┘   │
                                └─────────────────────────────────────────┘
```

Three contracts define the boundary. `MouseProvider` abstracts the OS input layer; `MonitorApi` abstracts the display layout; and `MouseController` owns the pure logic between them. Nothing in the controller imports Electron, nut.js, or any OS-specific module, which is what makes the unit tests fast, deterministic, and runnable in headless CI.

### 2.1 The contracts

```typescript
// packages/input-provider/src/mouse.ts
interface MouseProvider {
  moveAbsolute(input: MoveAbsoluteInput): Promise<void>;   // {x, y, displayIndex?}
  moveRelative(input: MoveRelativeInput): Promise<void>;   // {dx, dy}
  click(input: ClickInput): Promise<void>;                 // {button, action}
  scroll(input: ScrollInput): Promise<void>;               // {axis, amount}
  dragStart(input: DragStartInput): Promise<void>;
  dragMove(input: DragMoveInput): Promise<void>;
  dragEnd(input: DragStartInput): Promise<void>;
}

interface MonitorApi {
  getDisplays(): Promise<DisplayInfo[]>;   // live layout on every call
  currentDisplay(): Promise<DisplayInfo>;
}

interface DisplayInfo {
  displayIndex: number;
  geometry: { x: number; y: number; width: number; height: number }; // virtual units
  scaleFactor: number;   // passed through to the platform layer
  primary: boolean;
  label: string;
}
```

`DisplayInfo` deliberately carries no OS type (`Electron.Display`, `ScreenInfo`, …) — both the Electron-based production monitor source and the headless test fixture emit identical shapes, so the controller and every adapter down the chain stay oblivious to which one they have.

### 2.2 Platform adapters

The factory in `providers/factory.ts` implements a graceful degradation order so the receiver always starts, even in environments where no input backend is available:

| Rank | Provider | Backend | Selection rule |
|------|----------|---------|----------------|
| 1 | `NutJsMouseProvider` | nut.js 4.x (`mouse.move`, `mouse.drag`, `mouse.leftClick`/`rightClick`/`middleClick`/`dblClick`, scroll, drag) | Default when the bindings load |
| 2 | `NativeMouseProvider` | Per-platform reference paths — Windows `SendInput`, macOS CGEvent (via `cliclick`), Linux XTest (via `xdotool`) | Fallback when nut.js bindings fail (headless/CI, stripped builds) |
| 3 | `MockMouseProvider` | In-memory spy | Only when explicitly requested (`kind: "mock"`) |

A key property of the factory: construction never throws. If nut.js fails to load and the native helpers are unavailable, the factory returns the mock provider tagged `kind: "unavailable"` with a human-readable note, so the receiver can still launch and surface a clear status message instead of crashing at startup. The native backend modules implement a thin `NativeMouseBackend` contract, which means real native bindings (C++ addon, FFI) can replace the shell helpers later without touching any other file.

## 3. MouseController Behaviour

The controller in `packages/input-provider/src/controllers/MouseController.ts` is the pure core — roughly 220 lines, fully covered by tests, and injectable with its clock and throttle parameters.

### 3.1 Coordinate mapping

Senders transmit normalized coordinates in `[0, 1]` of a display, never raw pixels. The controller resolves the target display — `displayIndex` wins when provided, otherwise the OS-reported current display, falling back to the primary display — and maps:

```
localX = clamp(x, 0, 1) × display.geometry.width
virtualX = display.geometry.x + round(localX)
```

Rounding to integer virtual units is deliberate: sub-pixel moves are noise for the OS pointer. The `displayIndex` is forwarded to the provider along with the virtual coordinates, so multi-monitor configurations with different resolutions and scale factors are handled entirely by this mapping contract, not by the transport.

### 3.2 Throttling

A touchpad sender can emit several hundred move events per second; flooding the OS queue at that rate is wasted work and can even desync the pointer. The controller accepts one move frame per `inputThrottleMs` window (default **8 ms ≈ 125 Hz**, chosen against the protocol's ≤ 50 ms latency budget) and drops everything in between — the *latest* sample is always honoured because senders re-sample the pointer position for every frame. The same throttle applies to `moveRelative` and `dragMove`. The window and the clock (`now`) are constructor options, which is what keeps throttling behaviour deterministic in tests.

### 3.3 Drag state machine

Drag uses an explicit stateful trio. `dragMove` and `dragEnd` before `dragStart` throw a descriptive `InputError` with code `dragNotStarted`; `dragStart` with a duplicate active drag throws `dragAlreadyStarted`; non-draggable buttons are rejected with `invalidButton`. Only `left` and `middle` can drive a drag (`DRAG_BUTTONS`). Combined with the protocol's best-effort framing, this means a dropped connection mid-drag is observable rather than silently corrupting the pointer state — the receiver side can synthesize `dragEnd` when it sees moves without an active session (documented in protocol §4.3).

### 3.4 Validation and clamping

`scroll` clamps the signed amount to `SCROLL_CLAMP` (±15 ticks) and drops zero/no-ops before they reach the provider. Button strings are validated against `isMouseButton` / `isDragButton` boundary validators before anything else happens — untrusted protocol payloads are never passed to the controller raw.

## 4. Receiver Wiring: InputModule and InputService

`apps/receiver/src/main/inputModule.ts` is the composition root. It defines three typed tokens — `monitorToken`, `providerToken`, `controllerToken` — over a tiny hand-rolled DI container in `packages/input-provider/src/di.ts` (`Token`, `Container.register`, `Container.resolve`). No DI framework is pulled in: the receiver already carries a heavy dependency load, and the container shape (lazy factories, token-scoped resolution) is everything the app needs. The production monitor source is `ElectronMonitors`, a thin wrapper around `electron.screen.getAllDisplays()` mapped onto `DisplayInfo` — kept behind a class so unit tests never need the Electron module.

`InputService` (apps/receiver/src/main/inputService.ts) is where the network layer hands over to the input layer. For each of the six mouse frame types it registers a handler on the gateway's `FrameRouter`, and each handler follows the same three-step sequence:

1. **Permission gate.** The frame's session must be authenticated and hold the `"mouse"` permission scope; otherwise the socket is closed with code `4005`. Permissions are re-checked on every frame, not just at connect time, so an operator can revoke the mouse scope mid-session.
2. **Validation.** Payload fields are checked with the protocol boundary validators (`isMouseButton`, `isDragButton`, axis/amount shape) — invalid payloads are rejected silently, with zero side effects on the OS input stack.
3. **Delegation.** The validated payload is dispatched to the injected `MouseController`.

Input frames are fire-and-forget (`mid = 0`): handlers never send replies, keeping the mouse path at the lowest possible latency.

```typescript
// apps/receiver/src/main/networkService.ts (excerpt)
this.inputService = createInputService(inputContainer, (sessionId) =>
  this.gateway.findSession(sessionId),
);
// registerHandlers attaches the six Mouse* handlers to gateway.frameRouter
```

## 5. Protocol Frames (receiver view)

The mapping from protocol frame to controller call, as implemented in `InputService`:

| Frame | Payload check | Controller call |
|-------|--------------|-----------------|
| `MouseMove` 0x40 | `x`, `y` numeric in range | `moveAbsolute({x, y, displayIndex})` |
| `MouseClick` 0x41 | `button` ∈ left/right/middle; `action` ∈ down/up/click/dblclick | `click({button, action})` |
| `MouseScroll` 0x42 | `axis` ∈ vertical/horizontal; `amount` number | `scroll({axis, amount})` |
| `MouseDragStart` 0x43 | `button` ∈ left/middle | `dragStart({button})` |
| `MouseDragMove` 0x44 | `x`, `y` numeric in range | `dragMove({x, y, displayIndex})` |
| `MouseDragEnd` 0x45 | `button` ∈ left/middle | `dragEnd({button})` |

## 6. Testing

The test suite mirrors the production graph, layer by layer, so every failing test points at exactly one module.

| Suite | Count | What it proves |
|-------|-------|----------------|
| `input-provider` (unit) | 33 | Coordinate mapping math; boundary clamping; throttle window behaviour; drag state machine transitions and error codes; scroll clamping and no-op suppression; monitor picking rules (index, current, primary fallback); per-platform provider selection; mock/native/nutjs provider delegation |
| `apps/receiver/tests/inputService.test.ts` | 8 | Permission gate closes with 4005 when unauthenticated or missing the `mouse` scope; valid frames delegate to the controller with the expected payload shape (including `displayIndex` on moves); clicks/double-click/scroll dispatch; the full drag sequence round-trips; invalid payloads leave the provider untouched; all six frame types are registered; the DI container resolves the real pipeline (monitors → controller → provider) |

Two design details worth noting in the integration tests. First, `FixedMonitors(makeTestDisplays({ secondary: true }))` replaces the real monitor source in tests, giving the controller a deterministic two-monitor layout (1920×1080 primary + 2560×1440 secondary offset by 1920 px) so coordinate-mapping assertions stay exact regardless of the machine running CI. Second, the drag test advances fake timers by 10 ms between `dragMove` frames — this exercises the throttle rather than fighting it, asserting that the throttling contract holds end-to-end on the real receiver path.

## 7. CI Results

| Gate | Result |
|------|--------|
| Typecheck (12 workspaces) | 12 successful |
| Lint | 0 errors (1 pre-existing warning in sender) |
| Build | 7 successful |
| Tests | input-provider 33/33 · network 46/46 · receiver 16/16 · sender 8/8 (plus auth/protocol suites via Turborepo) |

## 8. Extensibility — Keyboard and Media Follow On

The architecture anticipated the next milestones. The `MouseProvider` interface sits beside `KeyboardProvider`/`MediaProvider` slots in the shared types, so Milestone 3b (keyboard) and 3c (media keys) will reuse the same controller–adapter–DI shape: a new controller, new frame handlers in `InputService` (permission scope `"keyboard"`, `"media"`), and new token registrations in the same composition root. The monitor abstraction is already general enough to drive per-keyboard-display key injection later, and the factory's degradation order will extend with `cliclick`-style reference paths for key events on each platform.
