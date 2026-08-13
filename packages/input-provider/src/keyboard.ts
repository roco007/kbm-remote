/**
 * Keyboard subsystem — platform-agnostic contracts.
 *
 * This module defines everything the keyboard subsystem needs without touching
 * any OS or input library. The protocol's key-identifier grammar
 * (`KeyX` letter keys, explicit modifier sides, US-layout names) is the
 * stable vocabulary; platform adapters translate it to their native codes.
 *
 * Grammar (documented in the protocol spec §4.4):
 *   - Letters:          "A".."Z" or "KeyA".."KeyZ"  (case-insensitive)
 *   - Digits:           "0".."9"
 *   - Printables:       space, punctuation via US-layout names ("Space",
 *                       "Period", "Minus", "Slash", "Backquote", …)
 *   - Modifiers:        "ControlLeft" | "ControlRight" | "ShiftLeft" |
 *                       "ShiftRight" | "AltLeft" | "AltRight" |
 *                       "MetaLeft" | "MetaRight"
 *   - Function keys:    "F1".."F24"
 *   - Editing:          "Backspace", "Tab", "Enter", "Escape", "Delete",
 *                       "Insert", "Home", "End", "PageUp", "PageDown",
 *                       "CapsLock", "Pause", "PrintScreen"
 *   - Arrows:           "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
 *   - Media:            "volumeUp" | "volumeDown" | "mute" | "playPause" |
 *                       "prevTrack" | "nextTrack"
 *
 * Long text goes through {@link KeyboardProvider.typeText}, never through a
 * simulated keypress stream — that is the only path that carries full
 * Unicode (including CJK and emoji), because OS key-event simulation is
 * inherently limited to what a physical keyboard can express.
 */

import { InputError } from "./mouse";

/** Maximum TextInput payload size — matches protocol §4.4 (4 KB). */
export const MAX_TEXT_INPUT_BYTES = 4096;

/** Key identifiers the platform adapters must be able to emit. */
export type KeyId =
  | LetterKey
  | DigitKey
  | PrintableKey
  | ModifierKey
  | FunctionKey
  | EditingKey
  | ArrowKey
  | MediaKey;

export type LetterKey =
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L"
  | "M"
  | "N"
  | "O"
  | "P"
  | "Q"
  | "R"
  | "S"
  | "T"
  | "U"
  | "V"
  | "W"
  | "X"
  | "Y"
  | "Z"
  | "KeyA"
  | "KeyB"
  | "KeyC"
  | "KeyD"
  | "KeyE"
  | "KeyF"
  | "KeyG"
  | "KeyH"
  | "KeyI"
  | "KeyJ"
  | "KeyK"
  | "KeyL"
  | "KeyM"
  | "KeyN"
  | "KeyO"
  | "KeyP"
  | "KeyQ"
  | "KeyR"
  | "KeyS"
  | "KeyT"
  | "KeyU"
  | "KeyV"
  | "KeyW"
  | "KeyX"
  | "KeyY"
  | "KeyZ";

export type DigitKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

/** Punctuation / symbol keys named after the US physical layout. */
export type PrintableKey =
  | "Space"
  | "Tab"
  | "Backspace"
  | "Enter"
  | "Escape"
  | "Delete"
  | "Insert"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown"
  | "CapsLock"
  | "Pause"
  | "PrintScreen"
  | "Backquote"
  | "Minus"
  | "Equal"
  | "BracketLeft"
  | "BracketRight"
  | "Backslash"
  | "Semicolon"
  | "Quote"
  | "Comma"
  | "Period"
  | "Slash"
  | "NumPad0"
  | "NumPad1"
  | "NumPad2"
  | "NumPad3"
  | "NumPad4"
  | "NumPad5"
  | "NumPad6"
  | "NumPad7"
  | "NumPad8"
  | "NumPad9"
  | "NumLock";

export type ModifierKey =
  | "ControlLeft"
  | "ControlRight"
  | "ShiftLeft"
  | "ShiftRight"
  | "AltLeft"
  | "AltRight"
  | "MetaLeft"
  | "MetaRight";

export type FunctionKey =
  | "F1"
  | "F2"
  | "F3"
  | "F4"
  | "F5"
  | "F6"
  | "F7"
  | "F8"
  | "F9"
  | "F10"
  | "F11"
  | "F12"
  | "F13"
  | "F14"
  | "F15"
  | "F16"
  | "F17"
  | "F18"
  | "F19"
  | "F20"
  | "F21"
  | "F22"
  | "F23"
  | "F24";

export type ArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

export type EditingKey = PrintableKey; // editing keys are printable-key names

/** Abstract media keys — mapped to OS media mechanisms by adapters. */
export type MediaKey =
  "volumeUp" | "volumeDown" | "mute" | "playPause" | "prevTrack" | "nextTrack";

/** All media key identifiers, for validation. */
export const MEDIA_KEYS: readonly MediaKey[] = [
  "volumeUp",
  "volumeDown",
  "mute",
  "playPause",
  "prevTrack",
  "nextTrack",
] as const;

export interface PressInput {
  /** Raw key identifiers — validated and normalized by the controller. */
  readonly keys: readonly unknown[];
}

export interface HoldInput {
  /** Raw key identifier — validated and normalized by the controller. */
  readonly key: unknown;
  /**
   * Optional long-press repetition: when positive, the held key is re-pressed
   * every `repeatIntervalMs` after `repeatStartMs`. Zero (default) means a
   * plain hold — the OS's own key-repeat takes over.
   */
  readonly repeatStartMs?: number;
  readonly repeatIntervalMs?: number;
}

export interface ReleaseInput {
  /** Raw key identifier — validated and normalized by the controller. */
  readonly key: unknown;
}

export interface TypeTextInput {
  readonly text: string;
}

export interface MediaKeyInput {
  readonly key: MediaKey;
}

export interface ShortcutInput {
  /** Raw key identifiers — validated and normalized by the controller. */
  readonly keys: readonly unknown[];
  /** How long to keep the combo depressed; default 120 ms. */
  readonly holdMs?: number;
}

export interface KeyboardProvider {
  readonly name: string;
  press(input: PressInput): Promise<void>;
  release(input: ReleaseInput): Promise<void>;
  typeText(input: TypeTextInput): Promise<void>;
  mediaKey(input: MediaKeyInput): Promise<void>;
}

export const MODIFIER_KEYS: readonly ModifierKey[] = [
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
] as const;

/** Is this identifier one of the eight modifier keys? */
export function isModifierKey(key: unknown): key is ModifierKey {
  return typeof key === "string" && (MODIFIER_KEYS as readonly string[]).includes(key);
}

/** Is this identifier one of the abstract media keys? */
export function isMediaKey(value: unknown): value is MediaKey {
  return typeof value === "string" && (MEDIA_KEYS as readonly string[]).includes(value);
}

/**
 * Validate a single key identifier from an untrusted payload. Returns the
 * same string narrowed to {@link KeyId} or throws.
 */
export function normalizeKeyId(value: unknown): KeyId {
  if (typeof value !== "string" || value.length === 0) {
    throw new InputError(
      `key "${String(value)}" is not a valid key identifier`,
      "invalidKey",
    );
  }
  if (isMediaKey(value)) return value;
  if ((MODIFIER_KEYS as readonly string[]).includes(value)) {
    return value as unknown as KeyId;
  }
  // Letters: "a".."z" (normalized to upper) or "KeyA".."KeyZ" (case-insensitive)
  if (/^[a-zA-Z]$/.test(value)) return value.toUpperCase() as unknown as KeyId;
  if (/^Key([a-zA-Z])$/.test(value)) {
    return `Key${value.slice(3).toUpperCase()}` as unknown as KeyId;
  }
  // Digits and layout-named keys
  if (/^[0-9]$/.test(value) || LAYOUT_KEYS.has(value)) return value as unknown as KeyId;
  // Function keys F1..F24
  if (/^F(1[0-9]|2[0-4]|[1-9])$/.test(value)) return value as unknown as KeyId;
  // Arrows
  if (/^Arrow(Up|Down|Left|Right)$/.test(value)) return value as unknown as KeyId;
  throw new InputError(`key "${value}" is not a valid key identifier`, "invalidKey");
}

/** Every US-layout printable/editing key name, kept as a set for O(1) lookup. */
const LAYOUT_KEYS = new Set<string>([
  "Space",
  "Tab",
  "Backspace",
  "Enter",
  "Escape",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "CapsLock",
  "Pause",
  "PrintScreen",
  "Backquote",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Comma",
  "Period",
  "Slash",
  "NumPad0",
  "NumPad1",
  "NumPad2",
  "NumPad3",
  "NumPad4",
  "NumPad5",
  "NumPad6",
  "NumPad7",
  "NumPad8",
  "NumPad9",
  "NumLock",
]);

/** Byte length of a string in UTF-8 — clamps TextInput payloads per spec. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair — count 4 bytes and skip the trailing surrogate.
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}
