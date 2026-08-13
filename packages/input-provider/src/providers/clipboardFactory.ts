/**
 * Clipboard provider selection — same degrade-as-you-go policy as mouse and
 * keyboard:
 *
 *   1. `native` — OS tooling (xclip / pbcopy / PowerShell), tried first
 *   2. `mock`   — only when explicitly requested (`kind: "mock"`)
 *
 * If native fails (missing tooling, unsupported platform), the mock
 * provider is returned tagged `kind: "unavailable"` with a human-readable
 * note, so the receiver can still start and surface a clear status message.
 */
import { ClipboardProvider } from "../clipboard";
import { MockClipboardProvider } from "./clipboardMock";
import { NativeClipboardProvider } from "./clipboardNative";

export type ClipboardProviderKind = "native" | "mock" | "unavailable";

export interface CreateClipboardProviderOptions {
  readonly kind?: ClipboardProviderKind;
  /** Override the runtime platform check (tests). */
  readonly platform?: NodeJS.Platform;
}

export interface ClipboardProviderSelection {
  readonly provider: ClipboardProvider;
  /** Which implementation is actually in use. */
  readonly kind: ClipboardProviderKind;
  /** Human-readable explanation of why this provider was chosen. */
  readonly note: string;
}

function tryNative(platform?: NodeJS.Platform): ClipboardProviderSelection | null {
  try {
    const provider = new NativeClipboardProvider(platform);
    return {
      provider,
      kind: "native",
      note: `native clipboard backend ("${provider.name}") for ${platform ?? process.platform}`,
    };
  } catch {
    return null;
  }
}

export function createClipboardProvider(
  options: CreateClipboardProviderOptions = {},
): ClipboardProviderSelection {
  if (options.kind === "mock") {
    return {
      provider: new MockClipboardProvider(),
      kind: "mock",
      note: "mock clipboard provider (explicitly requested)",
    };
  }

  if (options.kind === "native") {
    const selection = tryNative(options.platform);
    if (!selection) {
      return {
        provider: new MockClipboardProvider(),
        kind: "unavailable",
        note: `native clipboard backend requested but unavailable on ${options.platform ?? process.platform}`,
      };
    }
    return selection;
  }

  // Default: native first, fall back to unavailable mock.
  const native = tryNative(options.platform);
  if (native) return native;
  return {
    provider: new MockClipboardProvider(),
    kind: "unavailable",
    note: `no clipboard tooling found on ${options.platform ?? process.platform} — clipboard sync disabled until tooling is installed`,
  };
}
