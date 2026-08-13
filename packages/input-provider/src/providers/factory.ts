/**
 * Provider factory — the single entry point the receiver uses to obtain a
 * {@link MouseProvider}.
 *
 * Selection order (overridable via {@link CreateMouseProviderOptions}):
 *   1. `mock`      — only when explicitly requested (tests)
 *   2. `nutjs`     — default; falls back to native when the native bindings
 *                     fail to load (headless/CI environments)
 *   3. `native`    — per-platform direct OS path
 *
 * The factory NEVER throws on construction failure — it degrades to the next
 * candidate and, as a last resort, returns the mock provider tagged
 * `"unavailable"` so the receiver can still start and surface a clear
 * status message to the user.
 */
import { MouseProvider } from "../mouse";
import { MockMouseProvider } from "./mock";
import { NativeMouseProvider, createNativeBackend } from "./native";
import { NutJsMouseProvider } from "./nutjs";

export type MouseProviderKind = "nutjs" | "native" | "mock";

export interface CreateMouseProviderOptions {
  /** Force a specific provider (tests). */
  readonly kind?: MouseProviderKind;
  /** Override the runtime platform check (tests). */
  readonly platform?: NodeJS.Platform;
}

export interface MouseProviderSelection {
  readonly provider: MouseProvider;
  /** Which implementation is actually in use. */
  readonly kind: MouseProviderKind;
  /** Human-readable explanation of why this provider was chosen. */
  readonly note: string;
}

/**
 * Resolves the best available mouse provider. Side-effect-free and
 * idempotent — safe to call at every connection if preferences change.
 */
export function createMouseProvider(
  options: CreateMouseProviderOptions = {},
): MouseProviderSelection {
  const platform = options.platform ?? process.platform;

  if (options.kind === "mock") {
    return {
      provider: new MockMouseProvider(),
      kind: "mock",
      note: "mock provider (test build)",
    };
  }

  if (options.kind !== "native") {
    // Construction cannot fail — the nut.js bindings are only loaded lazily on
    // first input, so the import cost and failure surface live in the provider.
    return {
      provider: new NutJsMouseProvider(),
      kind: "nutjs",
      note: "nut.js runtime provider",
    };
  }

  try {
    const backend = createNativeBackend(platform);
    return {
      provider: new NativeMouseProvider(backend),
      kind: "native",
      note: `native ${platform} backend`,
    };
  } catch (_err) {
    if (options.kind === "native") {
      throw new Error("no native mouse backend available on this platform");
    }
  }

  return {
    provider: new MockMouseProvider(),
    kind: "mock",
    note: "no input provider available on this platform; input will be recorded but not emulated",
  };
}
