/**
 * KeyboardController — the pure core of the keyboard subsystem.
 *
 * Responsibilities:
 *   1. Validate key identifiers from untrusted protocol payloads against the
 *      stable grammar in {@link normalizeKeyId}, so platform adapters only
 *      ever see legal identifiers.
 *   2. Shortcuts — depress a combo, hold for `holdMs`, release in reverse
 *      order (modifiers first down, modifiers last up).
 *   3. Long press and key repeat — a KeyHold is a plain hold (the OS
 *      synthesizes repeats) unless the sender opts into application-level
 *      repeat with `repeatStartMs`/`repeatIntervalMs`, in which case the
 *      controller re-presses the key on an interval until the matching
 *      release.
 *   4. TextInput — length-bound check before delegating; full Unicode flows
 *      through this path only.
 *
 * Time-dependent behaviour (repeat timers, shortcut hold) goes through an
 * injected `sleep` so tests with fake timers stay deterministic.
 */
import {
  HoldInput,
  isMediaKey,
  KeyboardProvider,
  MAX_TEXT_INPUT_BYTES,
  MODIFIER_KEYS,
  normalizeKeyId,
  PressInput,
  ReleaseInput,
  ShortcutInput,
  TypeTextInput,
  utf8ByteLength,
  type KeyId,
  type ModifierKey,
} from "../keyboard";
import { InputError } from "../mouse";

export const DEFAULT_SHORTCUT_HOLD_MS = 120;
export const DEFAULT_REPEAT_START_MS = 500;
export const DEFAULT_REPEAT_INTERVAL_MS = 80;
export const MIN_REPEAT_INTERVAL_MS = 30;

export interface KeyboardControllerOptions {
  readonly provider: KeyboardProvider;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface ActiveRepeat {
  readonly key: string;
  readonly timer: ReturnType<typeof setInterval>;
}

export class KeyboardController {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly activeRepeats = new Map<string, ActiveRepeat>();

  constructor(private readonly options: KeyboardControllerOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Atomic combo press — shortcuts like ["ControlLeft","KeyC"]. */
  async pressKeys(input: PressInput): Promise<void> {
    if (!Array.isArray(input.keys) || input.keys.length === 0) {
      throw new InputError("shortcut needs at least one key", "invalidKeys");
    }
    const keys: KeyId[] = input.keys.map(normalizeKeyId);
    // Natural ordering: modifiers before the base key, matching how OS key
    // event stacks expect modifier-first combos (e.g. Ctrl+Shift+C).
    keys.sort(keyOrder);
    await this.options.provider.press({ keys });
  }

  /**
   * Begin holding a single key. A plain hold lets the OS synthesize repeats;
   * an explicit `repeatStartMs`/`repeatIntervalMs` opts into an
   * application-level repeat that the controller drives until
   * {@link releaseKey} is called for the same key.
   */
  async holdKey(input: HoldInput): Promise<void> {
    const key = normalizeKeyId(input.key);
    const keyTag = String(key);
    if (this.activeRepeats.has(keyTag)) {
      throw new InputError(`key "${String(key)}" is already held`, "keyAlreadyHeld");
    }
    await this.options.provider.press({ keys: [key] });
    const start = input.repeatStartMs ?? DEFAULT_REPEAT_START_MS;
    const interval = input.repeatIntervalMs ?? DEFAULT_REPEAT_INTERVAL_MS;
    if (start <= 0 || interval < MIN_REPEAT_INTERVAL_MS) return; // plain OS hold
    // Arm the repeat AFTER the start delay so it mirrors OS auto-repeat.
    await this.sleep(start);
    const timer = setInterval(() => {
      // Fire-and-forget: a missed repeat tick is acceptable for input.
      void this.options.provider.press({ keys: [key] }).catch(() => {});
    }, interval);
    this.activeRepeats.set(keyTag, { key: keyTag, timer });
  }

  /** Release a held key; silently no-ops for keys that were never held. */
  async releaseKey(input: ReleaseInput): Promise<void> {
    const key = normalizeKeyId(input.key);
    const active = this.activeRepeats.get(String(key));
    if (active) {
      clearInterval(active.timer);
      this.activeRepeats.delete(String(key));
    }
    await this.options.provider.release({ key });
  }

  /** Unicode text — the only path that carries full codepoint coverage. */
  async typeText(input: TypeTextInput): Promise<void> {
    if (typeof input.text !== "string") {
      throw new InputError("TextInput payload must be a string", "invalidText");
    }
    const bytes = utf8ByteLength(input.text);
    if (bytes > MAX_TEXT_INPUT_BYTES) {
      throw new InputError(
        `TextInput too large (${bytes} bytes, limit ${MAX_TEXT_INPUT_BYTES})`,
        "textTooLarge",
      );
    }
    if (input.text.length === 0) {
      throw new InputError("TextInput must not be empty", "emptyText");
    }
    await this.options.provider.typeText({ text: input.text });
  }

  /** Abstract media key — delegates straight through after validation. */
  async mediaKey(input: { key: unknown }): Promise<void> {
    if (!isMediaKey(input.key)) {
      throw new InputError(`unknown media key "${input.key}"`, "invalidMediaKey");
    }
    await this.options.provider.mediaKey({ key: input.key });
  }

  /** Shortcut: combo down (modifiers first), hold, modifiers-last release. */
  async shortcut(input: ShortcutInput): Promise<void> {
    const keys: KeyId[] = input.keys.map(normalizeKeyId);
    if (keys.length < 2) {
      throw new InputError("shortcut needs at least two keys", "invalidKeys");
    }
    const ordered = [...keys].sort(keyOrder);
    await this.options.provider.press({ keys: ordered });
    await this.sleep(input.holdMs ?? DEFAULT_SHORTCUT_HOLD_MS);
    for (let i = ordered.length - 1; i >= 0; i--) {
      await this.options.provider.release({ key: ordered[i]! });
    }
  }

  /** Held keys with application-level repeat armed — test/teardown access. */
  get activeRepeatCount(): number {
    return this.activeRepeats.size;
  }
}

/**
 * Sort order for simultaneous key presses: modifiers first (left side before
 * right), everything else alphabetically by identifier. Physical keyboards
 * produce modifier-first stacks for every combo, and alphabetical ordering
 * keeps "KeyC" before "KeyV" in Ctrl+C+V-free combos deterministic.
 */
export function keyOrder(a: KeyId, b: KeyId): number {
  const ai = MODIFIERS_ORDER.indexOf(a as ModifierKey);
  const bi = MODIFIERS_ORDER.indexOf(b as ModifierKey);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return String(a).localeCompare(String(b));
}

const MODIFIERS_ORDER: readonly ModifierKey[] = [...MODIFIER_KEYS];

void MODIFIER_KEYS; // kept to mirror the grammar module's canonical list
