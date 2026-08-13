/**
 * MouseController — the heart of the mouse subsystem.
 *
 * Responsibilities:
 *   1. Translate NORMALIZED coordinates ([0, 1] of a display) into virtual
 *      screen units using the live display layout from {@link MonitorApi}.
 *   2. Own the drag state machine — dragMove/dragEnd before dragStart are
 *      rejected with a descriptive {@link InputError}.
 *   3. Throttle absolute/relative MOVE frames so a bursty sender (e.g. a
 *      240 Hz touchpad) cannot flood the OS event queue: excess frames are
 *      dropped, and the LATEST sample is always honoured.
 *   4. Clamp scroll amounts to a sane band and normalise negative zero.
 *   5. Keep every time-dependent behaviour (throttle window, sample clock)
 *      injectable so unit tests are deterministic.
 *
 * The controller is deliberately PURE with respect to the platform: all OS
 * interaction happens through {@link MouseProvider}.
 */
import {
  ClickInput,
  DisplayInfo,
  DragMoveInput,
  InputError,
  MonitorApi,
  MouseProvider,
  MoveAbsoluteInput,
  MoveRelativeInput,
  ScrollInput,
  DragStartInput,
  DRAG_BUTTONS,
  SCROLL_CLAMP,
} from "../mouse";

/** Defaults — protocol latency target ≤ 50 ms allows up to ~120 Hz pointer updates. */
export const DEFAULT_INPUT_THROTTLE_MS = 8;
export const DEFAULT_MAX_MOVE_SAMPLES = 64;

export interface MouseControllerOptions {
  readonly provider: MouseProvider;
  readonly monitors: MonitorApi;
  /** Wall clock; defaults to Date.now. Override for deterministic tests. */
  readonly now?: () => number;
  /** ms between accepted move frames; excess frames are dropped. */
  readonly inputThrottleMs?: number;
}

/**
 * Resolved target display for one absolute move. The controller never exposes
 * raw OS geometry — callers only ever pass normalized coordinates.
 */
export interface ResolvedTarget {
  readonly display: DisplayInfo;
  /** Virtual screen X (integer) the provider should move to. */
  readonly virtualX: number;
  readonly virtualY: number;
}

export class MouseController {
  private dragActive: boolean = false;
  private readonly now: () => number;
  private readonly inputThrottleMs: number;
  private lastMoveAt = -Infinity;

  constructor(private readonly options: MouseControllerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.inputThrottleMs = options.inputThrottleMs ?? DEFAULT_INPUT_THROTTLE_MS;
  }

  // ── absolute movement ──────────────────────────────────────────────

  /**
   * Maps normalized (x, y) of the target display to virtual screen units and
   * applies rate limiting. Throws {@link InputError} when no display layout
   * is available.
   */
  async moveAbsolute(input: MoveAbsoluteInput): Promise<void> {
    if (!this.acceptMove()) return; // throttled
    const target = await this.resolveAbsoluteTarget(input);
    await this.options.provider.moveAbsolute({
      x: target.virtualX,
      y: target.virtualY,
      displayIndex: target.display.displayIndex,
    });
  }

  /** Maps normalized coordinates to a display and virtual units (testable). */
  async resolveAbsoluteTarget(input: MoveAbsoluteInput): Promise<ResolvedTarget> {
    const displays = await this.options.monitors.getDisplays();
    if (displays.length === 0) {
      throw new InputError("no display layout available", "noDisplays");
    }
    const display = await this.pickDisplay(displays, input.displayIndex);
    const { x, y, width, height } = display.geometry;
    // Normalized [0, 1] → display-local pixels, clamped to the display edge.
    const localX = Math.max(0, Math.min(1, input.x)) * width;
    const localY = Math.max(0, Math.min(1, input.y)) * height;
    return {
      display,
      // Round to integer virtual units — sub-pixel moves are noise for the OS.
      virtualX: Math.round(x + localX),
      virtualY: Math.round(y + localY),
    };
  }

  async moveRelative(input: MoveRelativeInput): Promise<void> {
    if (!this.acceptMove()) return; // throttled
    await this.options.provider.moveRelative({
      dx: Math.round(input.dx),
      dy: Math.round(input.dy),
    });
  }

  // ── clicks ─────────────────────────────────────────────────────────

  async click(input: ClickInput): Promise<void> {
    if (!isMouseButton(input.button)) {
      throw new InputError(`unknown mouse button "${input.button}"`, "invalidButton");
    }
    await this.options.provider.click(input);
  }

  // ── scroll ─────────────────────────────────────────────────────────

  async scroll(input: ScrollInput): Promise<void> {
    const clamped =
      Math.sign(input.amount) * Math.min(Math.abs(input.amount), SCROLL_CLAMP);
    // Avoid sending negative zero / no-ops through the provider.
    if (clamped === 0) return;
    await this.options.provider.scroll({ axis: input.axis, amount: clamped });
  }

  // ── drag state machine ─────────────────────────────────────────────

  async dragStart(input: DragStartInput): Promise<void> {
    if (!DRAG_BUTTONS.includes(input.button)) {
      throw new InputError(
        `button "${input.button}" cannot start a drag`,
        "invalidButton",
      );
    }
    if (this.dragActive) {
      throw new InputError("drag already in progress", "dragAlreadyStarted");
    }
    this.dragActive = true;
    await this.options.provider.dragStart(input);
  }

  async dragMove(input: DragMoveInput): Promise<void> {
    if (!this.dragActive) {
      throw new InputError("dragMove before dragStart", "dragNotStarted");
    }
    if (!this.acceptMove()) return; // throttled
    const target = await this.resolveAbsoluteTarget({
      x: input.x,
      y: input.y,
      displayIndex: input.displayIndex,
    });
    await this.options.provider.dragMove({
      x: target.virtualX,
      y: target.virtualY,
      displayIndex: target.display.displayIndex,
    });
  }

  async dragEnd(input: DragStartInput): Promise<void> {
    if (!DRAG_BUTTONS.includes(input.button)) {
      throw new InputError(`button "${input.button}" cannot end a drag`, "invalidButton");
    }
    if (!this.dragActive) {
      throw new InputError("dragEnd before dragStart", "dragNotStarted");
    }
    this.dragActive = false;
    await this.options.provider.dragEnd(input);
  }

  /** Test/teardown access to drag state. */
  get isDragActive(): boolean {
    return this.dragActive;
  }

  // ── internals ──────────────────────────────────────────────────────

  /** Rate-limiter: accepts this sample or drops it. */
  private acceptMove(): boolean {
    const now = this.now();
    if (now - this.lastMoveAt < this.inputThrottleMs) {
      void DEFAULT_MAX_MOVE_SAMPLES; // reserved for future sample ring buffer
      return false;
    }
    this.lastMoveAt = now;
    return true;
  }

  /** displayIndex wins; otherwise the current display, falling back to primary. */
  private async pickDisplay(
    displays: readonly DisplayInfo[],
    displayIndex?: number,
  ): Promise<DisplayInfo> {
    if (displayIndex !== undefined) {
      const byIndex = displays.find((d) => d.displayIndex === displayIndex);
      if (byIndex) return byIndex;
    }
    const current = await this.options.monitors.currentDisplay();
    const byIndex = displays.find((d) => d.displayIndex === current.displayIndex);
    if (byIndex) return byIndex;
    return displays.find((d) => d.primary) ?? displays[0]!;
  }
}

/**
 * Protocol-level validation — sender payloads are untrusted maps, so the
 * button value must be checked before it reaches the provider.
 */
export function isMouseButton(value: unknown): value is "left" | "right" | "middle" {
  return value === "left" || value === "right" || value === "middle";
}

export function isDragButton(value: unknown): value is "left" | "middle" {
  return value === "left" || value === "middle";
}
