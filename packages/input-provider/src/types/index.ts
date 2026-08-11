/**
 * InputProvider interface contract.
 *
 * The receiver emulates input exclusively through this interface; providers
 * (nut.js default, native SendInput/CGEvent/XTest fallback) implement it.
 * Mirrors Architecture §2.1 — swapping providers never changes the services.
 */

export interface InputProvider {
  readonly name: string;

  // Mouse
  moveMouse(display: number, x: number, y: number): Promise<void>;
  click(
    button: "left" | "right" | "middle",
    action: "down" | "up" | "click" | "dblclick",
  ): Promise<void>;
  scroll(axis: "vertical" | "horizontal", amount: number): Promise<void>;
  dragStart(button: "left" | "middle"): Promise<void>;
  dragMove(x: number, y: number): Promise<void>;
  dragEnd(button: "left" | "middle"): Promise<void>;

  // Keyboard
  pressKeys(keys: string[]): Promise<void>;
  holdKey(key: string): Promise<void>;
  releaseKey(key: string): Promise<void>;
  textInput(text: string): Promise<void>;

  // Media
  mediaKey(
    key: "volumeUp" | "volumeDown" | "mute" | "playPause" | "prevTrack" | "nextTrack",
  ): Promise<void>;

  // Commands
  lockScreen(): Promise<void>;
  sleep(): Promise<void>;
  openApp(appName: string): Promise<void>;
}
