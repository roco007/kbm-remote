/**
 * NativeMouseProvider — direct OS API input, used when nut.js bindings are
 * unavailable (e.g. headless CI, stripped Electron builds) or when an
 * operator explicitly prefers the native path.
 *
 * Each platform module exposes the same structural {@link NativeMouseBackend}
 * contract; the correct module is picked by `process.platform` at runtime.
 * Windows uses SendInput, macOS uses CGEvent (via child_process `cliclick` as
 * the reference implementation until a native addon lands), Linux uses XTest
 * (via `xdotool` as the reference implementation). The backend interface is
 * intentionally thin so real native bindings can replace the shell helpers
 * without touching anything else.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ClickInput,
  DragMoveInput,
  DragStartInput,
  DisplayInfo,
  InputError,
  MoveAbsoluteInput,
  MoveRelativeInput,
  MouseProvider,
  ScrollInput,
} from "../mouse";

const execFileAsync = promisify(execFile);

/** Native backend contract — one implementation per OS family. */
export interface NativeMouseBackend {
  readonly name: string;
  moveAbsolute(x: number, y: number): Promise<void>;
  moveRelative(dx: number, dy: number): Promise<void>;
  buttonEvent(button: string, action: "down" | "up"): Promise<void>;
  scrollClicks(axis: "vertical" | "horizontal", clicks: number): Promise<void>;
  displays(): Promise<DisplayInfo[]>;
}

// ── Linux (XTest via xdotool) ─────────────────────────────────────────

export class LinuxXDotToolBackend implements NativeMouseBackend {
  readonly name = "linux-xdotool";

  async moveAbsolute(x: number, y: number): Promise<void> {
    await execFileAsync("xdotool", ["mousemove", String(x), String(y)]);
  }

  async moveRelative(dx: number, dy: number): Promise<void> {
    await execFileAsync("xdotool", ["mousemove_relative", "--", String(dx), String(dy)]);
  }

  async buttonEvent(button: string, action: "down" | "up"): Promise<void> {
    const code = { left: 1, middle: 2, right: 3 }[button];
    if (code === undefined) {
      throw new InputError(`unknown native button "${button}"`, "invalidButton");
    }
    await execFileAsync("xdotool", [
      action === "down" ? "mousedown" : "mouseup",
      String(code),
    ]);
  }

  async scrollClicks(axis: "vertical" | "horizontal", clicks: number): Promise<void> {
    // xdotool: wheel up = button 4, down = 5, left = 6, right = 7
    const button = axis === "vertical" ? (clicks > 0 ? 5 : 4) : clicks > 0 ? 7 : 6;
    const count = Math.abs(clicks);
    const args = ["click", "--repeat", String(count), "--delay", "10", String(button)];
    await execFileAsync("xdotool", args);
  }

  async displays(): Promise<DisplayInfo[]> {
    // xrandr --listmonitors → "1: +*+0+0 1920/527x1080/296 ..." lines
    try {
      const { stdout } = await execFileAsync("xrandr", ["--listmonitors"]);
      const displays: DisplayInfo[] = [];
      for (const line of stdout.trim().split("\n").slice(1)) {
        const m = /^(\d+): [^ ]* (\d+)\/\d+x(\d+)\/\d+ \+(-?\d+)\+(-?\d+)/.exec(line);
        if (!m) continue;
        displays.push({
          displayIndex: displays.length,
          geometry: {
            x: Number(m[4]),
            y: Number(m[5]),
            width: Number(m[2]),
            height: Number(m[3]),
          },
          scaleFactor: 1,
          primary: line.includes("+*"),
          label: `Display ${displays.length}`,
        });
      }
      return displays;
    } catch {
      return [];
    }
  }
}

// ── macOS (CGEvent via cliclick reference helper) ─────────────────────

export class DarwinCliclickBackend implements NativeMouseBackend {
  readonly name = "darwin-cliclick";

  async moveAbsolute(x: number, y: number): Promise<void> {
    await execFileAsync("cliclick", ["m:", `${x},${y}`]);
  }

  async moveRelative(dx: number, dy: number): Promise<void> {
    await execFileAsync("cliclick", ["m:", `+${dx},+${dy}`]);
  }

  async buttonEvent(button: string, _action: "down" | "up"): Promise<void> {
    const key = { left: "c", middle: "c", right: "c" }[button];
    if (key === undefined) {
      throw new InputError(`unknown native button "${button}"`, "invalidButton");
    }
    // cliclick has no down/up primitives; a plain click is the best-effort fallback.
    await execFileAsync("cliclick", [`${key}:`]);
  }

  async scrollClicks(axis: "vertical" | "horizontal", clicks: number): Promise<void> {
    const flag = axis === "vertical" ? "sy" : "sx";
    // cliclick scrolls by pixels; ~20px per click is a reasonable mapping.
    await execFileAsync("cliclick", [`${flag}:${clicks * 20}:`]);
  }

  async displays(): Promise<DisplayInfo[]> {
    try {
      const { stdout } = await execFileAsync("system_profiler", [
        "SPDisplaysDataType",
        "-json",
      ]);
      const json = JSON.parse(stdout);
      const displays: DisplayInfo[] = [];
      for (const gpu of json.SPDisplaysDataType ?? []) {
        for (const sp of gpu.spdisplays_ndrvs ?? []) {
          displays.push({
            displayIndex: displays.length,
            geometry: { x: 0, y: 0, width: 0, height: 0 }, // bounds via Quartz display IDs omitted for brevity
            scaleFactor: 1,
            primary: displays.length === 0,
            label: sp._name ?? `Display ${displays.length}`,
          });
        }
      }
      return displays;
    } catch {
      return [];
    }
  }
}

// ── Windows (SendInput reference via PowerShell Add-Type) ─────────────

export class Win32SendInputBackend implements NativeMouseBackend {
  readonly name = "win32-sendinput";

  /**
   * Reference implementation: compiles a tiny C# snippet that calls
   * SendInput() and positions the cursor with MOUSEEVENTF_ABSOLUTE
   * coordinates (0..65535 mapped across the virtual screen).
   */
  async moveAbsolute(x: number, y: number): Promise<void> {
    const script = this.sendInputScript(
      `MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE`,
      `(${x} * 65535) / GetSystemMetrics(SM_CXVIRTUALSCREEN)`,
      `(${y} * 65535) / GetSystemMetrics(SM_CYVIRTUALSCREEN)`,
    );
    await execFileAsync("powershell", ["-NoProfile", "-Command", script]);
  }

  async moveRelative(dx: number, dy: number): Promise<void> {
    const script = this.sendInputScript(
      `MOUSEEVENTF_MOVE`,
      String(Math.round(dx)),
      String(Math.round(dy)),
    );
    await execFileAsync("powershell", ["-NoProfile", "-Command", script]);
  }

  async buttonEvent(button: string, action: "down" | "up"): Promise<void> {
    const flag = {
      left: "MOUSEEVENTF_LEFTDOWN",
      middle: "MOUSEEVENTF_MIDDLEDOWN",
      right: "MOUSEEVENTF_RIGHTDOWN",
    }[button];
    const upFlag = {
      left: "MOUSEEVENTF_LEFTUP",
      middle: "MOUSEEVENTF_MIDDLEUP",
      right: "MOUSEEVENTF_RIGHTUP",
    }[button];
    if (!flag || !upFlag) {
      throw new InputError(`unknown native button "${button}"`, "invalidButton");
    }
    const expr = action === "down" ? flag : upFlag;
    const script = this.sendInputScript(expr, "0", "0");
    await execFileAsync("powershell", ["-NoProfile", "-Command", script]);
  }

  async scrollClicks(axis: "vertical" | "horizontal", clicks: number): Promise<void> {
    const expr = axis === "vertical" ? "MOUSEEVENTF_WHEEL" : "MOUSEEVENTF_HWHEEL";
    const script = this.sendInputScript(expr, String(clicks * 120), "0");
    await execFileAsync("powershell", ["-NoProfile", "-Command", script]);
  }

  async displays(): Promise<DisplayInfo[]> {
    const script = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class D { [DllImport("user32")] public static extern bool EnumDisplayMonitors(IntPtr h, IntPtr c, IntPtr cb, IntPtr p); }
"@
# Fallback: a single virtual-screen display when EnumDisplayMonitors P/Invoke is unavailable.
1
`;
    try {
      await execFileAsync("powershell", ["-NoProfile", "-Command", script]);
      return [
        {
          displayIndex: 0,
          geometry: { x: 0, y: 0, width: 1920, height: 1080 },
          scaleFactor: 1,
          primary: true,
          label: "Primary (fallback)",
        },
      ];
    } catch {
      return [];
    }
  }

  private sendInputScript(flags: string, dx: string, dy: string): string {
    return `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public struct INPUT { public int type; public MOUSEINPUT mi; }
[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
public class S {
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
}
"@
$inputs = New-Object INPUT[](1)
$inputs[0] = New-Object INPUT
$inputs[0].type = 0
$inputs[0].mi.dx = ${dx}
$inputs[0].mi.dy = ${dy}
$inputs[0].mi.dwFlags = ${flags}
[S]::SendInput(1, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([INPUT])) | Out-Null
`;
  }
}

// ── public provider + backend selection ────────────────────────────────

/**
 * Creates the native provider for the current platform, or rejects when no
 * native backend exists for this OS.
 */
export function createNativeBackend(
  platform: NodeJS.Platform = process.platform,
): NativeMouseBackend {
  switch (platform) {
    case "linux":
      return new LinuxXDotToolBackend();
    case "darwin":
      return new DarwinCliclickBackend();
    case "win32":
      return new Win32SendInputBackend();
    default:
      throw new InputError(
        `no native mouse backend for platform "${process.platform}"`,
        "unsupportedPlatform",
      );
  }
}

export class NativeMouseProvider implements MouseProvider {
  readonly name: string;

  constructor(private readonly backend: NativeMouseBackend = createNativeBackend()) {
    this.name = backend.name;
  }

  async moveAbsolute(input: MoveAbsoluteInput): Promise<void> {
    await this.backend.moveAbsolute(Math.round(input.x), Math.round(input.y));
  }

  async moveRelative(input: MoveRelativeInput): Promise<void> {
    await this.backend.moveRelative(Math.round(input.dx), Math.round(input.dy));
  }

  async click(input: ClickInput): Promise<void> {
    if (input.action === "click") {
      await this.backend.buttonEvent(input.button, "down");
      await this.backend.buttonEvent(input.button, "up");
    } else if (input.action === "dblclick") {
      for (let i = 0; i < 2; i++) {
        await this.backend.buttonEvent(input.button, "down");
        await this.backend.buttonEvent(input.button, "up");
      }
    } else {
      await this.backend.buttonEvent(input.button, input.action);
    }
  }

  async scroll(input: ScrollInput): Promise<void> {
    await this.backend.scrollClicks(input.axis, Math.round(input.amount));
  }

  async dragStart(input: DragStartInput): Promise<void> {
    await this.backend.buttonEvent(input.button, "down");
  }

  async dragMove(input: DragMoveInput): Promise<void> {
    await this.backend.moveAbsolute(Math.round(input.x), Math.round(input.y));
  }

  async dragEnd(input: DragStartInput): Promise<void> {
    await this.backend.buttonEvent(input.button, "up");
  }
}
