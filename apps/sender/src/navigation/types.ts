/**
 * Typed route map for the sender's stack navigator (React Navigation).
 *
 * Kept in one module so every screen and the navigator share a single source
 * of truth; screens are registered in the root layout.
 */
export type RootStackParamList = {
  Home: undefined;
  PairDevice: undefined;
  Touchpad: undefined;
  Keyboard: undefined;
  MediaControls: undefined;
  Clipboard: undefined;
  PresentationMode: undefined;
  Settings: undefined;
};

export const HUB_SCREENS = [
  "Touchpad",
  "Keyboard",
  "MediaControls",
  "Clipboard",
  "PresentationMode",
] as const;
