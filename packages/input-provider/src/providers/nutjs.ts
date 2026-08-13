/**
 * NutJsMouseProvider — default runtime provider built on
 * {@link https://github.com/nut-tree-fork/nut-js @nut-tree-fork/nut-js}.
 *
 * The dependency is loaded LAZILY (dynamic import) so that environments
 * without native bindings (CI sandboxes, tests) never pay the import cost
 * and the receiver's startup stays fast. The API surface used here is the
 * documented nut.js 4.x surface: `mouse`/`screen` singletons and `Point`.
 */
import {
  ClickInput,
  DragMoveInput,
  DragStartInput,
  DisplayInfo,
  MoveAbsoluteInput,
  MoveRelativeInput,
  MouseProvider,
  ScrollInput,
} from "../mouse";

/** Minimal structural types for the nut.js objects we touch. */
interface NutPoint {
  x: number;
  y: number;
}

interface NutMouse {
  move(target: NutPoint): Promise<void>;
  leftClick(): Promise<void>;
  rightClick(): Promise<void>;
  middleClick(): Promise<void>;
  leftButtonDown(): Promise<void>;
  leftButtonUp(): Promise<void>;
  middleButtonDown(): Promise<void>;
  middleButtonUp(): Promise<void>;
  rightButtonDown(): Promise<void>;
  rightButtonUp(): Promise<void>;
  scrollDown(amount: number): Promise<void>;
  scrollUp(amount: number): Promise<void>;
  scrollLeft(amount: number): Promise<void>;
  scrollRight(amount: number): Promise<void>;
}

interface NutScreen {
  availableMonitors(): Promise<
    Array<{
      name: string;
      main: boolean;
      bounds: NutPoint & { width: number; height: number };
    }>
  >;
  currentMonitor(): Promise<{
    name: string;
    bounds: NutPoint & { width: number; height: number };
  } | null>;
}

interface NutApi {
  mouse: NutMouse;
  screen: NutScreen;
  Point: new (x: number, y: number) => NutPoint;
}

let cachedNut: NutApi | null = null;

async function loadNutJs(): Promise<NutApi> {
  if (cachedNut) return cachedNut;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = await import(/* webpackIgnore: true */ "@nut-tree-fork/nut-js");
  cachedNut = pkg as unknown as NutApi;
  return cachedNut;
}

export class NutJsMouseProvider implements MouseProvider {
  readonly name = "nutjs";

  async moveAbsolute(input: MoveAbsoluteInput): Promise<void> {
    const nut = await loadNutJs();
    await nut.mouse.move(new nut.Point(Math.round(input.x), Math.round(input.y)));
  }

  async moveRelative(input: MoveRelativeInput): Promise<void> {
    const nut = await loadNutJs();
    // nut.js exposes the current cursor only via `mouse.location()` in 4.x;
    // fall back to the provider's cached last position when unavailable.
    const pos =
      typeof (nut.mouse as unknown as { location?: () => NutPoint }).location ===
      "function"
        ? (nut.mouse as unknown as { location: () => NutPoint }).location()
        : (this.lastPosition ?? { x: 0, y: 0 });
    this.lastPosition = {
      x: pos.x + Math.round(input.dx),
      y: pos.y + Math.round(input.dy),
    };
    await nut.mouse.move(new nut.Point(this.lastPosition.x, this.lastPosition.y));
  }

  private lastPosition?: NutPoint;

  async click(input: ClickInput): Promise<void> {
    const nut = await loadNutJs();
    switch (input.action) {
      case "click":
        return nut.mouse[`${input.button}Click`]();
      case "dblclick":
        // nut.js has no dedicated double-click; two rapid clicks emulate it.
        await nut.mouse[`${input.button}Click`]();
        return nut.mouse[`${input.button}Click`]();
      case "down":
        return nut.mouse[`${input.button}ButtonDown`]();
      case "up":
        return nut.mouse[`${input.button}ButtonUp`]();
    }
  }

  async scroll(input: ScrollInput): Promise<void> {
    const nut = await loadNutJs();
    const axis = input.axis === "vertical" ? "scrollDown" : "scrollRight";
    // Positive amount scrolls down/right; negative reverses direction.
    if (input.amount >= 0) {
      await nut.mouse[axis](input.amount);
    } else {
      await nut.mouse[input.axis === "vertical" ? "scrollUp" : "scrollLeft"](
        -input.amount,
      );
    }
  }

  async dragStart(_input: DragStartInput): Promise<void> {
    const nut = await loadNutJs();
    await nut.mouse[`${_input.button}ButtonDown`]();
  }

  async dragMove(input: DragMoveInput): Promise<void> {
    const nut = await loadNutJs();
    await nut.mouse.move(new nut.Point(Math.round(input.x), Math.round(input.y)));
  }

  async dragEnd(input: DragStartInput): Promise<void> {
    const nut = await loadNutJs();
    await nut.mouse[`${input.button}ButtonUp`]();
  }
}

/** Lazy display introspection (used by the controller's MonitorApi). */
export async function nutDisplays(): Promise<DisplayInfo[]> {
  const nut = await loadNutJs();
  const monitors = await nut.screen.availableMonitors();
  return monitors.map((m, displayIndex) => ({
    displayIndex,
    geometry: {
      x: m.bounds.x,
      y: m.bounds.y,
      width: m.bounds.width,
      height: m.bounds.height,
    },
    scaleFactor: 1, // nut.js reports device scale via a separate API if needed
    primary: m.main,
    label: m.name,
  }));
}
