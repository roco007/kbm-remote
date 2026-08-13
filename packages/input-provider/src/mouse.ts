/**
 * Mouse subsystem — interfaces.
 *
 * The mouse subsystem translates protocol frames (MouseMove 0x40, MouseClick 0x41,
 * MouseScroll 0x42, MouseDragStart/Move/End 0x43–0x45) into OS-native pointer
 * events. Every concrete mechanism (nut.js, Win32 SendInput, macOS CGEvent,
 * X11/XTest) implements {@link MouseProvider}; callers only depend on this
 * interface, so the platform layer is fully swappable.
 *
 * Coordinates across the wire are NORMALIZED: absolute positions arrive as
 * fractions in [0, 1] of the target display's geometry, so the controller is
 * display-resolution independent. Relative deltas arrive in pixels (screen
 * units) and are passed through with optional clamping.
 */

/** Mouse buttons accepted by the protocol. */
export type MouseButton = "left" | "right" | "middle";

/** Drag-capable buttons (mouse buttons 1 and 2 only). */
export type DragButton = "left" | "middle";

/** Scroll direction. */
export type ScrollAxis = "vertical" | "horizontal";

/** Rectangular geometry of a display, in virtual screen units. */
export interface DisplayGeometry {
  /** Virtual X origin relative to the primary display's (0, 0). */
  readonly x: number;
  /** Virtual Y origin relative to the primary display's (0, 0). */
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One connected display, resolved from the OS at runtime. */
export interface DisplayInfo {
  /** Stable zero-based index; used by the protocol's optional displayIndex field. */
  readonly displayIndex: number;
  readonly geometry: DisplayGeometry;
  readonly scaleFactor: number;
  readonly primary: boolean;
  /** Human-readable label, e.g. "Color LCD" or "DELL U2723QE". */
  readonly label: string;
}

/** Reads the OS display layout — injected so tests can supply fixed layouts. */
export interface MonitorApi {
  getDisplays(): Promise<DisplayInfo[]>;
  /** Current display under the pointer (best-effort; may return primary). */
  currentDisplay(): Promise<DisplayInfo>;
}

export interface MoveAbsoluteInput {
  /** Normalized coordinates in [0, 1] of the target display. */
  readonly x: number;
  readonly y: number;
  /** Target display by index; undefined = display under the pointer, fallback primary. */
  readonly displayIndex?: number;
}

export interface MoveRelativeInput {
  readonly dx: number;
  readonly dy: number;
}

export interface ClickInput {
  readonly button: MouseButton;
  readonly action: "click" | "dblclick" | "down" | "up";
}

export interface ScrollInput {
  readonly axis: ScrollAxis;
  /** Scroll amount in clicks (lines). Positive = down/right. Clamped by the controller. */
  readonly amount: number;
}

export interface DragStartInput {
  readonly button: DragButton;
}

export interface DragMoveInput {
  /** Normalized absolute position of the drag head. */
  readonly x: number;
  readonly y: number;
  readonly displayIndex?: number;
}

/**
 * The abstraction boundary. Every mechanism implements this interface; the
 * {@link MouseController} and the rest of the receiver depend on it only.
 */
export interface MouseProvider {
  readonly name: string;

  moveAbsolute(target: MoveAbsoluteInput): Promise<void>;
  moveRelative(delta: MoveRelativeInput): Promise<void>;
  click(input: ClickInput): Promise<void>;
  scroll(input: ScrollInput): Promise<void>;
  dragStart(input: DragStartInput): Promise<void>;
  dragMove(target: DragMoveInput): Promise<void>;
  dragEnd(input: DragStartInput): Promise<void>;
}

/** Buttons allowed to drive the drag state machine. */
export const DRAG_BUTTONS: readonly DragButton[] = ["left", "middle"];

/** Maximum scroll amount per frame (protocol §4.3) — prevents wheel floods. */
export const SCROLL_CLAMP = 15;

/** Thrown by any input provider operation that cannot be performed right now. */
export class InputError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "noDisplays"
      | "invalidButton"
      | "dragNotStarted"
      | "dragAlreadyStarted"
      | "providerUnavailable"
      | "unsupportedPlatform",
  ) {
    super(message);
  }
}
