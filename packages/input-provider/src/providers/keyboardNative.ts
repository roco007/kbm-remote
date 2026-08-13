/**
 * NativeKeyboardProvider — direct OS-path keyboard backend, used when nut.js
 * bindings are unavailable (headless CI, stripped Electron builds) or an
 * operator explicitly prefers the native route.
 *
 * Mirrors the mouse native path: a per-platform {@link NativeKeyboardBackend}
 * selected by `process.platform`, with shell-reference implementations
 * (Linux `xdotool key`, macOS `cliclick k:`, Windows PowerShell `SendInput`
 * with virtual-key codes). The backend contract is thin on purpose — real
 * native bindings (C++ addon / FFI) can replace the shell helpers without
 * touching anything above this file.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { InputError } from "../mouse";
import {
  KeyboardProvider,
  MediaKeyInput,
  PressInput,
  ReleaseInput,
  TypeTextInput,
  type KeyId,
} from "../keyboard";

const execFileAsync = promisify(execFile);

// ── grammar → native codes ────────────────────────────────────────────

/** Windows virtual-key codes used by the SendInput reference backend. */
export const WIN_VK: Readonly<Record<string, number>> = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0d, Escape: 0x1b, Space: 0x20,
  Insert: 0x2d, Delete: 0x2e, Home: 0x24, End: 0x23, PageUp: 0x21,
  PageDown: 0x22, CapsLock: 0x14, Pause: 0x13, PrintScreen: 0x2c,
  NumLock: 0x90, Backquote: 0xc0, Minus: 0xbd, Equal: 0xbb,
  BracketLeft: 0xdb, BracketRight: 0xdd, Backslash: 0xdc,
  Semicolon: 0xba, Quote: 0xde, Comma: 0xbc, Period: 0xbe, Slash: 0xbf,
  ArrowUp: 0x26, ArrowDown: 0x28, ArrowLeft: 0x25, ArrowRight: 0x27,
  ControlLeft: 0xa2, ControlRight: 0xa3, ShiftLeft: 0xa0, ShiftRight: 0xa1,
  AltLeft: 0xa4, AltRight: 0xa5, MetaLeft: 0x5b, MetaRight: 0x5c,
  NumPad0: 0x60, NumPad1: 0x61, NumPad2: 0x62, NumPad3: 0x63, NumPad4: 0x64,
  NumPad5: 0x65, NumPad6: 0x66, NumPad7: 0x67, NumPad8: 0x68, NumPad9: 0x69,
  volumeUp: 0xaf, volumeDown: 0xae, mute: 0xad, playPause: 0xb3,
  prevTrack: 0xa6, nextTrack: 0xb0,
};

/** xdotool / X11 keysym names used by the Linux reference backend. */
export const X_KEYS: Readonly<Record<string, string>> = {
  Backspace: "BackSpace", Enter: "Return", Escape: "Escape", Space: "space",
  Delete: "Delete", Insert: "Insert", Home: "Home", End: "End",
  PageUp: "Page_Up", PageDown: "Page_Down", CapsLock: "Caps_Lock",
  Pause: "Pause", PrintScreen: "Print", NumLock: "Num_Lock",
  Backquote: "grave", Minus: "minus", Equal: "equal",
  BracketLeft: "bracketleft", BracketRight: "bracketright",
  Backslash: "backslash", Semicolon: "semicolon", Quote: "apostrophe",
  Comma: "comma", Period: "period", Slash: "slash",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  ControlLeft: "Control_L", ControlRight: "Control_R",
  ShiftLeft: "Shift_L", ShiftRight: "Shift_R",
  AltLeft: "Alt_L", AltRight: "Alt_R",
  MetaLeft: "Super_L", MetaRight: "Super_R",
  NumPad0: "KP_0", NumPad1: "KP_1", NumPad2: "KP_2", NumPad3: "KP_3",
  NumPad4: "KP_4", NumPad5: "KP_5", NumPad6: "KP_6", NumPad7: "KP_7",
  NumPad8: "KP_8", NumPad9: "KP_9",
  volumeUp: "XF86AudioRaiseVolume", volumeDown: "XF86AudioLowerVolume",
  mute: "XF86AudioMute", playPause: "XF86AudioPlay",
  prevTrack: "XF86AudioPrev", nextTrack: "XF86AudioNext",
};

/** cliclick key abbreviations used by the macOS reference backend. */
const MAC_KEYS: Readonly<Record<string, string>> = {
  Backspace: "del", Enter: "ret", Escape: "esc", Space: "spc",
  Delete: "⌦", Tab: "⇥",
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  ControlLeft: "ctrl", ControlRight: "ctrl",
  ShiftLeft: "shift", ShiftRight: "shift",
  AltLeft: "alt", AltRight: "alt",
  MetaLeft: "cmd", MetaRight: "cmd",
  volumeUp: "↑", volumeDown: "↓", mute: "mute", playPause: "paly",
  prevTrack: "prev", nextTrack: "next",
};

/**
 * Translate one {@link KeyId} to the native code for the given backend.
 * Letters and digits fall through to lowercase strings (xdotool/cliclick
 * accept them directly; the Windows path maps "A" → VK 0x41).
 */
function nativeCode(keyId: KeyId | unknown, mapping: Record<string, string | number>): string {
  const s = String(keyId);
  const mapped = mapping[s];
  if (mapped !== undefined) return String(mapped);
  if (/^[a-zA-Z]$/.test(s)) return s.toLowerCase();
  const keyMatch = /^Key([A-Z])$/.exec(s);
  if (keyMatch?.[1]) return keyMatch[1].toLowerCase();
  if (/^F(1[0-9]|2[0-4]|[1-9])$/.test(s)) return s;
  throw new InputError(`no native code for key "${keyId}"`, "unsupportedKey");
}

// ── backend contract + per-platform implementations ───────────────────

export interface NativeKeyboardBackend {
  readonly name: string;
  pressKey(code: string): Promise<void>;
  releaseKey(code: string): Promise<void>;
  typeText(text: string): Promise<void>;
  mediaEvent(code: string): Promise<void>;
}

export class LinuxXDotKeyBackend implements NativeKeyboardBackend {
  readonly name = "linux-xdotool-key";

  async pressKey(code: string): Promise<void> {
    await execFileAsync("xdotool", ["key", "--clearmodifiers", code]);
  }

  async releaseKey(code: string): Promise<void> {
    // xdotool has no key-up; best-effort: re-press then up via up modifier.
    await execFileAsync("xdotool", ["keyup", code]).catch(() => {});
  }

  async typeText(text: string): Promise<void> {
    // type --clearmodifiers carries UTF-8 text (XSendEvent) up to clipboard size.
    await execFileAsync("xdotool", ["type", "--clearmodifiers", "--", text]);
  }

  async mediaEvent(code: string): Promise<void> {
    await execFileAsync("xdotool", ["key", "--clearmodifiers", code]);
  }
}

export class DarwinCliclickKeyBackend implements NativeKeyboardBackend {
  readonly name = "darwin-cliclick-key";

  async pressKey(code: string): Promise<void> {
    await execFileAsync("cliclick", ["kd:", code]);
  }

  async releaseKey(code: string): Promise<void> {
    await execFileAsync("cliclick", ["ku:", code]);
  }

  async typeText(text: string): Promise<void> {
    await execFileAsync("cliclick", ["t:", text]);
  }

  async mediaEvent(code: string): Promise<void> {
    await execFileAsync("cliclick", ["kp:", code]);
  }
}

export class Win32KeyBackend implements NativeKeyboardBackend {
  readonly name = "win32-key-sendinput";

  async pressKey(code: string): Promise<void> {
    const vk = Number(code);
    if (!Number.isFinite(vk)) {
      throw new InputError(`non-numeric VK code "${code}"`, "unsupportedKey");
    }
    await execFileAsync("powershell", [
      "-NoProfile",
      "-Command",
      this.sendKeyEventScript(vk, /* down */ true),
    ]);
  }

  async releaseKey(code: string): Promise<void> {
    const vk = Number(code);
    if (!Number.isFinite(vk)) {
      throw new InputError(`non-numeric VK code "${code}"`, "unsupportedKey");
    }
    await execFileAsync("powershell", [
      "-NoProfile",
      "-Command",
      this.sendKeyEventScript(vk, /* down */ false),
    ]);
  }

  async typeText(text: string): Promise<void> {
    // Reference path: PowerShell clipboard + Ctrl+V. Full Unicode, no
    // per-character simulation — identical in contract to the nut.js path.
    const escaped = text.replace(/'/g, "''");
    await execFileAsync("powershell", [
      "-NoProfile",
      "-Command",
      `Set-Clipboard -Value '${escaped}'; Start-Sleep -Milliseconds 80; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v');`,
    ]);
  }

  async mediaEvent(code: string): Promise<void> {
    await this.pressKey(code);
    await this.releaseKey(code);
  }

  private sendKeyEventScript(vk: number, down: boolean): string {
    const flag = down ? "KEYEVENTF_KEYDOWN" : "KEYEVENTF_KEYUP";
    return `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public struct KINPUT { public int type; public KEYBDINPUT ki; }
[StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
public class K {
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, KINPUT[] inputs, int size);
}
"@
$inputs = New-Object KINPUT[](1)
$inputs[0] = New-Object KINPUT
$inputs[0].type = 1
$inputs[0].ki.wVk = ${vk}
$inputs[0].ki.wScan = 0
$inputs[0].ki.dwFlags = ${flag}
[K]::SendInput(1, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([KINPUT])) | Out-Null
`;
  }
}

export function createNativeKeyboardBackend(
  platform: NodeJS.Platform = process.platform,
): NativeKeyboardBackend {
  switch (platform) {
    case "linux":
      return new LinuxXDotKeyBackend();
    case "darwin":
      return new DarwinCliclickKeyBackend();
    case "win32":
      return new Win32KeyBackend();
    default:
      throw new InputError(
        `no native keyboard backend for platform "${process.platform}"`,
        "unsupportedPlatform",
      );
  }
}

// ── provider ───────────────────────────────────────────────────────────

export class NativeKeyboardProvider implements KeyboardProvider {
  readonly name: string;

  constructor(
    private readonly backend: NativeKeyboardBackend = createNativeKeyboardBackend(),
    private readonly keyMap: Record<string, string | number> = platformKeyMap(
      backend.name,
    ),
  ) {
    this.name = backend.name;
  }

  async press(input: PressInput): Promise<void> {
    for (const key of input.keys) {
      await this.backend.pressKey(nativeCode(key, this.keyMap));
    }
  }

  async release(input: ReleaseInput): Promise<void> {
    await this.backend.releaseKey(nativeCode(input.key, this.keyMap));
  }

  async typeText(input: TypeTextInput): Promise<void> {
    await this.backend.typeText(input.text);
  }

  async mediaKey(input: MediaKeyInput): Promise<void> {
    await this.backend.mediaEvent(nativeCode(input.key, this.keyMap));
  }
}

function platformKeyMap(backendName: string): Record<string, string | number> {
  if (backendName.startsWith("linux")) return { ...X_KEYS };
  if (backendName.startsWith("darwin")) return { ...MAC_KEYS };
  if (backendName.startsWith("win32")) return { ...WIN_VK };
  throw new InputError(`unknown native backend "${backendName}"`, "unsupportedPlatform");
}

void null as unknown as MediaKeyInput; // keeps the MediaKeyInput import referenced
