/**
 * NutJsKeyboardProvider — default keyboard backend, built on
 * {@link https://nutjs.dev @nut-tree-fork/nut-js 4.x}.
 *
 * Translation map (`packages/input-provider/src/keyboard.ts` grammar →
 * nut.js `Key` enum): letters use the `KeyX` form directly, modifiers map
 * to the explicit left/right variants, media keys map to `Audio*` entries.
 *
 * Key repeat on a held key is delegated to the OS — nut.js `pressKey` leaves
 * the key depressed and the OS auto-repeat takes over. Unicode text goes
 * through `keyboard.type(string)`, which carries full codepoint coverage
 * (caveat: very exotic scripts may fall back to the platform clipboard path
 * inside nut.js; that is a nut.js implementation detail, not a leaky
 * abstraction here — the contract is "the text appears in the focused
 * field").
 */
import {
  KeyboardProvider,
  MediaKeyInput,
  PressInput,
  ReleaseInput,
  TypeTextInput,
  type KeyId,
} from "../keyboard";
import { InputError } from "../mouse";

/**
 * Shape of the nut.js keyboard we depend on — narrow on purpose so the
 * adapter compiles against any future minor revision as long as the four
 * methods exist.
 */
export interface NutJsKeyboard {
  type(...input: (string | object)[]): Promise<unknown>;
  pressKey(...keys: (string | number | object)[]): Promise<unknown>;
  releaseKey(...keys: (string | number | object)[]): Promise<unknown>;
}

/** Lazy access to the nut.js keyboard singleton — the module is only loaded
 *  when this provider is actually used. */
async function loadNutJsKeyboard(): Promise<NutJsKeyboard> {
  try {
    const nut = (await import("@nut-tree-fork/nut-js")) as unknown as {
      keyboard: NutJsKeyboard;
    };
    if (!nut.keyboard || typeof nut.keyboard.type !== "function") {
      throw new Error("nut.js keyboard surface missing");
    }
    return nut.keyboard;
  } catch (cause) {
    throw new InputError(
      "nut.js keyboard bindings unavailable",
      "bindingsUnavailable",
    );
  }
}

/**
 * Resolve one {@link KeyId} to a nut.js `Key` enum value. The enum lives in
 * the peer `@nut-tree-fork/shared` package; the import is kept dynamic so
 * the provider degrades cleanly when the dependency is absent.
 */
async function resolveKeyEnum(): Promise<Record<string, number>> {
  const nut = (await import("@nut-tree-fork/nut-js")) as unknown as {
    Key: Record<string, number>;
  };
  if (!nut.Key) throw new Error("nut.js Key enum missing");
  return nut.Key;
}

function requireEnum(keyEnum: Record<string, number>, name: string): string | number {
  const value = keyEnum[name];
  if (value === undefined) {
    throw new InputError(`nut.js has no code for key "${name}"`, "unsupportedKey");
  }
  return value;
}

function toNutKey(keyId: unknown, keyEnum: Record<string, number>): string | number {
  switch (String(keyId)) {
    // Letters and digits
    case "0": case "1": case "2": case "3": case "4":
    case "5": case "6": case "7": case "8": case "9":
      return requireEnum(keyEnum, `Num${keyId}`);
    case "Space": return requireEnum(keyEnum, "Space");
    case "Backquote": return requireEnum(keyEnum, "Grave");
    case "BracketLeft": return requireEnum(keyEnum, "LeftBracket");
    case "BracketRight": return requireEnum(keyEnum, "RightBracket");
    case "Quote": return requireEnum(keyEnum, "Quote");
    case "PrintScreen": return requireEnum(keyEnum, "Print");
    // Modifiers
    case "ControlLeft": return requireEnum(keyEnum, "LeftControl");
    case "ControlRight": return requireEnum(keyEnum, "RightControl");
    case "ShiftLeft": return requireEnum(keyEnum, "LeftShift");
    case "ShiftRight": return requireEnum(keyEnum, "RightShift");
    case "AltLeft": return requireEnum(keyEnum, "LeftAlt");
    case "AltRight": return requireEnum(keyEnum, "RightAlt");
    case "MetaLeft": return requireEnum(keyEnum, "LeftWin");
    case "MetaRight": return requireEnum(keyEnum, "RightWin");
    // Arrows
    case "ArrowUp": return requireEnum(keyEnum, "Up");
    case "ArrowDown": return requireEnum(keyEnum, "Down");
    case "ArrowLeft": return requireEnum(keyEnum, "Left");
    case "ArrowRight": return requireEnum(keyEnum, "Right");
    // Media — sent through the same key enum (AudioMute … AudioNext)
    case "volumeUp": return requireEnum(keyEnum, "AudioVolUp");
    case "volumeDown": return requireEnum(keyEnum, "AudioVolDown");
    case "mute": return requireEnum(keyEnum, "AudioMute");
    case "playPause": return requireEnum(keyEnum, "AudioPlay");
    case "prevTrack": return requireEnum(keyEnum, "AudioPrev");
    case "nextTrack": return requireEnum(keyEnum, "AudioNext");
    default:
      // Function keys and remaining layout names map 1:1 (F1…F24, Tab,
      // Enter, Backspace, …) because the grammar was chosen to match nut.js.
      return requireEnum(keyEnum, String(keyId));
  }
}

export class NutJsKeyboardProvider implements KeyboardProvider {
  readonly name = "nutjs";

  async press(input: PressInput): Promise<void> {
    const [kb, keyEnum] = await Promise.all([
      loadNutJsKeyboard(),
      resolveKeyEnum(),
    ]);
    const keys = input.keys.map((k) => toNutKey(k, keyEnum));
    await kb.pressKey(...keys);
  }

  async release(input: ReleaseInput): Promise<void> {
    const [kb, keyEnum] = await Promise.all([
      loadNutJsKeyboard(),
      resolveKeyEnum(),
    ]);
    await kb.releaseKey(toNutKey(input.key, keyEnum));
  }

  async typeText(input: TypeTextInput): Promise<void> {
    const kb = await loadNutJsKeyboard();
    // nut.js keyboard.type accepts a plain string and injects the full text,
    // Unicode included — no per-character key simulation.
    await kb.type(input.text);
  }

  async mediaKey(input: MediaKeyInput): Promise<void> {
    const [kb, keyEnum] = await Promise.all([
      loadNutJsKeyboard(),
      resolveKeyEnum(),
    ]);
    const key = toNutKey(input.key, keyEnum);
    await kb.pressKey(key);
    await kb.releaseKey(key);
  }
}
