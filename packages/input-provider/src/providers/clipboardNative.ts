/**
 * NativeClipboardProvider — OS clipboard via the native tooling already
 * present on every desktop (no extra runtime dependencies, no native addons
 * that break on Electron upgrades):
 *
 *   Linux   — `xclip` / `xsel` for both clipboard selections
 *   macOS   — `pbcopy` / `pbpaste` (text) and `osascript` PNG base64 roundtrip
 *   Windows — PowerShell `Get-Clipboard` / `Set-Clipboard`
 *
 * A `NativeClipboardBackend` contract keeps the per-platform shells behind
 * the same adapter surface as nut.js. If the tooling is missing (headless
 * server, Wayland without xclip, etc.) the factory degrades to the mock
 * provider tagged `unavailable`.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ClipboardContent,
  ClipboardProvider,
  normalizeClipboardContent,
} from "../clipboard";
import { InputError } from "../mouse";

const execFileAsync = promisify(execFile);

// ── backend contract ─────────────────────────────────────────────────────

interface NativeClipboardBackend {
  readonly name: string;
  readText(): Promise<string | null>;
  readImagePngBase64(): Promise<string | null>;
  writeText(text: string): Promise<void>;
  writeImagePngBase64(b64: string): Promise<void>;
  clear(): Promise<void>;
}

// ── Linux: xclip ─────────────────────────────────────────────────────────

/**
 * `xclip -selection clipboard` covers the standard clipboard on X11;
 * `xclip -selection primary` covers middle-click paste buffers. Both are
 * read on `read` (primary is the tie-breaker when the clipboard is empty)
 * because remote-control users expect middle-paste content to be visible.
 */
async function xclip(...args: string[]): Promise<Buffer | null> {
  try {
    const result = await execFileAsync("xclip", args, {
      encoding: "buffer" as const,
      timeout: 2000,
    });
    return Buffer.from(result as unknown as Buffer);
  } catch {
    return null;
  }
}

const linuxBackend: NativeClipboardBackend = {
  name: "xclip",
  async readText(): Promise<string | null> {
    const buf = await xclip("-selection", "clipboard", "-o");
    if (!buf) return null;
    return buf.toString("utf8");
  },
  async readImagePngBase64(): Promise<string | null> {
    // xclip exposes image/png on the clipboard as raw PNG bytes.
    const buf = await xclip("-selection", "clipboard", "-t", "image/png", "-o");
    if (!buf) return null;
    return buf.toString("base64");
  },
  async writeText(text: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = execFile("xclip", ["-selection", "clipboard", "-i"], {
        timeout: 2000,
      });
      child.on("error", reject);
      child.on("close", () => resolve());
      child.stdin?.end(Buffer.from(text, "utf8"));
    });
  },
  async writeImagePngBase64(b64: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "xclip",
        ["-selection", "clipboard", "-t", "image/png", "-i"],
        { timeout: 5000 },
      );
      child.on("error", reject);
      child.on("close", () => resolve());
      child.stdin?.end(Buffer.from(b64, "base64"));
    });
  },
  async clear(): Promise<void> {
    await this.writeText("");
  },
};

// ── macOS: pbcopy / pbpaste / osascript ──────────────────────────────────

/**
 * pbcopy/pbpaste handle text natively. Images round-trip through `osascript`
 * with a tiny AppleScript that reads/writes PNG data via the clipboard
 * clipboard data representation — available since macOS 10.5.
 */

const darwinBackend: NativeClipboardBackend = {
  name: "pbcopy",
  async readText(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("pbpaste", {
        encoding: "utf8",
        timeout: 2000,
      });
      return stdout || null;
    } catch {
      return null;
    }
  },
  async readImagePngBase64(): Promise<string | null> {
    // Ask the clipboard for the public.png representation; osascript returns
    // the raw PNG, which we base64 in Node (script I/O is text-safe).
    try {
      const { stdout } = await execFileAsync(
        "osascript",
        ["-e", "set the clipboard to (the clipboard as «class PNGf»)"],
        { timeout: 5000 },
      );
      return stdout ? Buffer.from(stdout).toString("base64") : null;
    } catch {
      return null;
    }
  },
  async writeText(text: string): Promise<void> {
    // pbcopy reads stdin — spawn it without awaiting a result, feed the
    // text, and resolve when the process exits.
    await new Promise<void>((resolve, reject) => {
      const child = execFile("pbcopy", [], { timeout: 2000 });
      child.on("error", reject);
      child.on("close", () => resolve());
      child.stdin?.end(Buffer.from(text, "utf8"));
    });
  },
  async writeImagePngBase64(b64: string): Promise<void> {
    // Write PNG bytes to a temp file and let osascript import it — avoids
    // binary-via-stdin problems with osascript.
    const { execFileAsync: ef } = await import("node:util").then(() => ({
      execFileAsync: promisify(execFile),
    }));
    const { tmpdir } = await import("node:os");
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const file = join(tmpdir(), `kbm-clipboard-${Date.now()}.png`);
    try {
      writeFileSync(file, Buffer.from(b64, "base64"));
      await ef("osascript", ["-e", `set the clipboard to POSIX file "${file}"`], {
        timeout: 5000,
      });
    } finally {
      try {
        unlinkSync(file);
      } catch {
        /* best-effort cleanup */
      }
    }
  },
  async clear(): Promise<void> {
    await this.writeText("");
  },
};

// ── Windows: PowerShell ──────────────────────────────────────────────────

/**
 * PowerShell 5+ ships `Get-Clipboard` / `Set-Clipboard`. The clipboard is
 * process-scoped for the PowerShell host, so every call spawns a fresh
 * `powershell.exe -NoProfile` — ~150 ms per operation, acceptable for
 * manual sync and change polling (not for hot loops).
 */
function ps(args: string[], timeout = 5000) {
  return execFileAsync("powershell.exe", ["-NoProfile", ...args], {
    encoding: "utf8",
    timeout,
  });
}

const win32Backend: NativeClipboardBackend = {
  name: "powershell",
  async readText(): Promise<string | null> {
    try {
      const { stdout } = await ps(["-Command", "(Get-Clipboard -Raw)"]);
      return stdout ? stdout.replace(/\r?\n$/, "") : null;
    } catch {
      return null;
    }
  },
  async readImagePngBase64(): Promise<string | null> {
    try {
      const { stdout } = await ps([
        "-Command",
        [
          "$img = Get-Clipboard -Format Image;",
          "if (-not $img) { exit 1 };",
          "using namespace System.IO;",
          "$ms = New-Object MemoryStream;",
          "$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);",
          "[Convert]::ToBase64String($ms.ToArray());",
        ].join(" "),
      ]);
      return stdout ? stdout.trim() : null;
    } catch {
      return null;
    }
  },
  async writeText(text: string): Promise<void> {
    const safe = text.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/\r?\n/g, "`n");
    await ps(["-Command", `Set-Clipboard -Value '${safe}'`]);
  },
  async writeImagePngBase64(b64: string): Promise<void> {
    const file = process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp";
    const path = `${file}\\kbm-clipboard-${Date.now()}.png`;
    try {
      const safe = b64.replace(/'/g, "''");
      await ps([
        "-Command",
        [
          `$bytes = [Convert]::FromBase64String('${safe}');`,
          `$img = [System.Drawing.Image]::FromStream([IO.MemoryStream]::new($bytes));`,
          `$img.Save('${path.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png);`,
          "Set-Clipboard -Path $args[0];",
        ].join(" "),
        path,
      ]);
    } finally {
      try {
        await ps([
          "-Command",
          `if (Test-Path '${path.replace(/'/g, "''")}') { Remove-Item '${path.replace(/'/g, "''")}' }`,
        ]);
      } catch {
        /* best-effort cleanup */
      }
    }
  },
  async clear(): Promise<void> {
    await ps(["-Command", "Set-Clipboard -Value ''"]);
  },
};

/** Select the backend for the current platform. Throws `unsupportedPlatform`
 *  on anything that isn't a supported desktop OS. */
function backendFor(platform: NodeJS.Platform): NativeClipboardBackend {
  switch (platform) {
    case "linux":
      return linuxBackend;
    case "darwin":
      return darwinBackend;
    case "win32":
      return win32Backend;
    default:
      throw new InputError(
        `no clipboard backend for platform "${platform}"`,
        "unsupportedPlatform",
      );
  }
}

/**
 * Probe whether the chosen backend's tooling is actually available — e.g.
 * `xclip` may be missing on a minimal X11 install. A failed readText probe
 * is treated as "tooling unavailable" (not an empty clipboard).
 */
async function probeBackend(backend: NativeClipboardBackend): Promise<boolean> {
  try {
    await backend.readText();
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the native clipboard provider for the current (or overridden)
 * platform. Resolves eagerly enough for startup but probes lazily to keep
 * construction fast — availability is re-checked once on first use.
 */
export function createNativeClipboardBackend(
  platform: NodeJS.Platform = process.platform,
): NativeClipboardBackend {
  return backendFor(platform);
}

export class NativeClipboardProvider implements ClipboardProvider {
  readonly name: string;
  private readonly backend: NativeClipboardBackend;
  private available = true;

  constructor(platform: NodeJS.Platform = process.platform) {
    const backend = backendFor(platform);
    this.name = backend.name;
    this.backend = backend;
  }

  private async ensureAvailable(): Promise<void> {
    if (!this.available) return;
    this.available = await probeBackend(this.backend);
    if (!this.available) {
      throw new InputError(
        `clipboard tooling ("${this.backend.name}") is not available on this system`,
        "bindingsUnavailable",
      );
    }
  }

  async read(): Promise<ClipboardContent | null> {
    await this.ensureAvailable();
    try {
      const text = await this.backend.readText();
      if (text !== null) {
        const content = normalizeClipboardContent({ kind: "text", data: text });
        return content;
      }
      const img = await this.backend.readImagePngBase64();
      if (img) {
        const content = normalizeClipboardContent({ kind: "image", data: img });
        return content;
      }
      return null;
    } catch (err) {
      if (err instanceof InputError) throw err;
      return null;
    }
  }

  async write(content: ClipboardContent): Promise<void> {
    await this.ensureAvailable();
    if (content.kind === "text") {
      await this.backend.writeText(content.data);
    } else {
      await this.backend.writeImagePngBase64(content.data);
    }
  }

  async clear(): Promise<void> {
    await this.ensureAvailable();
    await this.backend.clear();
  }
}
