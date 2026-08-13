/**
 * Screen registry — every screen in the sender (UX §4, S1–S9).
 *
 * The navigator (src/App.tsx) imports from here so adding a screen only
 * requires registering it in the stack and this registry stays the single
 * point of truth for route → component mapping.
 */
export { default as HomeScreen } from "./HomeScreen";
export { default as PairDeviceScreen } from "./PairDeviceScreen";
export { default as TouchpadScreen } from "./TouchpadScreen";
export { default as KeyboardScreen } from "./KeyboardScreen";
export { default as MediaControlsScreen } from "./MediaControlsScreen";
export { default as ClipboardScreen } from "./ClipboardScreen";
export { default as PresentationModeScreen } from "./PresentationModeScreen";
export { default as SettingsScreen } from "./SettingsScreen";

export const SCREEN_NAMES = [
  "Home",
  "PairDevice",
  "Touchpad",
  "Keyboard",
  "MediaControls",
  "Clipboard",
  "PresentationMode",
  "Settings",
] as const;
