/**
 * MockMouseProvider — test spy implementing {@link MouseProvider}.
 *
 * Records every call with its argument in order. Tests assert on the recorded
 * history instead of the OS, so the controller and integration paths stay
 * deterministic and hermetic.
 */
import {
  ClickInput,
  DragMoveInput,
  DragStartInput,
  MoveAbsoluteInput,
  MoveRelativeInput,
  MouseProvider,
  ScrollInput,
  DisplayInfo,
  MonitorApi,
} from "../mouse";

export interface MockCall<T> {
  readonly method: keyof MouseProvider;
  readonly input: T;
}

export type MockHistory = ReadonlyArray<MockCall<unknown>>;

export class MockMouseProvider implements MouseProvider {
  readonly name = "mock";
  readonly calls: MockCall<unknown>[] = [];

  /** Throw from any method by registering `{moveAbsolute: err}` etc. */
  failOn: Partial<Record<keyof MouseProvider, Error>> = {};

  async moveAbsolute(input: MoveAbsoluteInput): Promise<void> {
    this.check("moveAbsolute");
    this.calls.push({ method: "moveAbsolute", input });
  }

  async moveRelative(input: MoveRelativeInput): Promise<void> {
    this.check("moveRelative");
    this.calls.push({ method: "moveRelative", input });
  }

  async click(input: ClickInput): Promise<void> {
    this.check("click");
    this.calls.push({ method: "click", input });
  }

  async scroll(input: ScrollInput): Promise<void> {
    this.check("scroll");
    this.calls.push({ method: "scroll", input });
  }

  async dragStart(input: DragStartInput): Promise<void> {
    this.check("dragStart");
    this.calls.push({ method: "dragStart", input });
  }

  async dragMove(input: DragMoveInput): Promise<void> {
    this.check("dragMove");
    this.calls.push({ method: "dragMove", input });
  }

  async dragEnd(input: DragStartInput): Promise<void> {
    this.check("dragEnd");
    this.calls.push({ method: "dragEnd", input });
  }

  private check(method: keyof MouseProvider): void {
    const err = this.failOn[method];
    if (err) throw err;
  }
}

/** Fixed display layout for deterministic tests — no OS needed. */

export class FixedMonitors implements MonitorApi {
  constructor(private readonly displays: DisplayInfo[]) {}

  async getDisplays(): Promise<DisplayInfo[]> {
    return [...this.displays];
  }

  async currentDisplay(): Promise<DisplayInfo> {
    return this.displays[0] ?? this.displays[this.displays.length - 1]!;
  }
}

/**
 * Sensible test fixtures: a 1920x1080 primary display at origin plus an
 * optional 2560x1440 secondary placed 1920px to the right.
 */
export function makeTestDisplays(options?: {
  secondary?: boolean;
  secondaryOffsetX?: number;
}): DisplayInfo[] {
  const secondary = options?.secondary;
  const primary: DisplayInfo = {
    displayIndex: 0,
    geometry: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    primary: true,
    label: "Test Primary",
  };
  if (!secondary) return [primary];
  return [
    primary,
    {
      displayIndex: 1,
      geometry: {
        x: options?.secondaryOffsetX ?? 1920,
        y: 0,
        width: 2560,
        height: 1440,
      },
      scaleFactor: 1.25,
      primary: false,
      label: "Test Secondary",
    },
  ];
}
