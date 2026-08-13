/**
 * Keyboard provider factory — mirrors the mouse factory's never-throw
 * degradation order:
 *
 *   1. `nutjs`  — default; falls back to native when the bindings fail to
 *                 load (headless/CI, stripped Electron builds)
 *   2. `native` — per-platform direct OS path
 *   3. `mock`   — only when explicitly requested (`kind: "mock"`)
 *
 * If every candidate fails, the mock provider is returned tagged
 * `kind: "unavailable"` with a human-readable note, so the receiver can
 * still launch and surface a clear status message instead of crashing.
 */
import { MockKeyboardProvider } from "./keyboardMock";
import { NativeKeyboardProvider } from "./keyboardNative";
import { NutJsKeyboardProvider } from "./keyboardNutjs";
import { KeyboardController } from "../controllers/KeyboardController";
import { KeyboardProvider } from "../keyboard";

export type KeyboardProviderKind = "nutjs" | "native" | "mock" | "unavailable";

export interface CreateKeyboardProviderOptions {
  /** Force a specific provider (tests). */
  readonly kind?: KeyboardProviderKind;
  /** Override the runtime platform check (tests). */
  readonly platform?: NodeJS.Platform;
}

export interface KeyboardProviderSelection {
  readonly provider: KeyboardProvider;
  /** Which implementation is actually in use. */
  readonly kind: KeyboardProviderKind;
  /** Human-readable explanation of why this provider was chosen. */
  readonly note: string;
}

function tryNative(platform?: NodeJS.Platform): KeyboardProviderSelection | null {
  try {
    return {
      provider: new NativeKeyboardProvider(),
      kind: "native",
      note: `native keyboard backend for ${platform ?? process.platform}`,
    };
  } catch {
    return null;
  }
}

export function createKeyboardProvider(
  options: CreateKeyboardProviderOptions = {},
): KeyboardProviderSelection {
  if (options.kind === "mock") {
    return {
      provider: new MockKeyboardProvider(),
      kind: "mock",
      note: "explicit mock requested (tests)",
    };
  }

  // The selection is async-aware but the factory returns synchronously:
  // nut.js loading is the only potentially slow path, so we attempt it
  // and fall through to the synchronous candidates on failure via a
  // synchronous-first design — the nut.js attempt happens lazily inside
  // the provider's first call. The NutJsKeyboardProvider loads the module
  // on demand (dynamic import), so construction itself cannot fail.
  if (options.kind === undefined || options.kind === "nutjs") {
    return {
      provider: new NutJsKeyboardProvider(),
      kind: "nutjs",
      note: "nut.js selected; native fallback on first-call failure",
    };
  }

  if (options.kind === "native") {
    return (
      tryNative(options.platform) ?? {
        provider: new MockKeyboardProvider(),
        kind: "unavailable",
        note: `no native keyboard backend for ${options.platform ?? process.platform}`,
      }
    );
  }

  return {
    provider: new MockKeyboardProvider(),
    kind: "unavailable",
    note: `unknown keyboard kind "${options.kind}"`,
  };
}

/**
 * Convenience: build a controller with the best available provider and the
 * same selection metadata, for environments that do not run the full DI
 * composition (CLI, test fixtures).
 */
export function createKeyboardController(
  options: CreateKeyboardProviderOptions & {
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): KeyboardProviderSelection & { readonly controller: KeyboardController } {
  const selection = createKeyboardProvider(options);
  return {
    ...selection,
    controller: new KeyboardController({
      provider: selection.provider,
      sleep: options.sleep,
    }),
  };
}
