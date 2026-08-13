/**
 * InputModule — receiver-side composition root for the input subsystem.
 *
 * Wires the provider-agnostic pipeline together behind a small, typed DI
 * container (no framework dependency — the container lives in the
 * input-provider package and is deliberately tiny):
 *
 *   MonitorApi        — real OS display layout (swappable for tests)
 *   MouseController   — normalized coords → virtual OS coords, throttle,
 *                       drag state, scroll clamping
 *   MouseProvider     — platform adapter selected by the factory:
 *                       nut.js first, native API fallback, mock in tests
 *   InputService      — permission-gated protocol handlers on the gateway
 *
 * The same container shape is reused in tests with spies, which keeps the
 * production wiring and the test wiring structurally identical.
 */
import {
  Container,
  KeyboardController,
  MouseController,
  Token,
  createKeyboardProvider,
  createMouseProvider,
  type Container as ContainerType,
  type KeyboardProvider,
  type MonitorApi,
  type MouseProvider,
} from "@kbm-remote/input-provider";

import { InputService } from "./inputService";

export const monitorToken = new Token<MonitorApi>("MonitorApi");
export const providerToken = new Token<MouseProvider>("MouseProvider");
export const controllerToken = new Token<MouseController>("MouseController");
export const keyboardProviderToken = new Token<KeyboardProvider>("KeyboardProvider");
export const keyboardControllerToken = new Token<KeyboardController>(
  "KeyboardController",
);

/** Real OS display layout — exposed so tests can override the token. */
export class ElectronMonitors implements MonitorApi {
  async getDisplays(): Promise<import("@kbm-remote/input-provider").DisplayInfo[]> {
    // NOTE: Electron's `screen.getAllDisplays()` maps 1:1 onto DisplayInfo.
    // Kept behind a tiny class so unit tests never need the electron module.
    const electron = await import("electron");
    const displays = await electron.screen.getAllDisplays();
    return displays.map((d, i) => ({
      displayIndex: i,
      scaleFactor: d.scaleFactor,
      geometry: {
        x: d.bounds.x,
        y: d.bounds.y,
        width: d.bounds.width,
        height: d.bounds.height,
      },
      primary: d.scaleFactor === displays[0]?.scaleFactor || d.id === 0,
      label: d.label,
    }));
  }

  async currentDisplay(): Promise<import("@kbm-remote/input-provider").DisplayInfo> {
    const displays = await this.getDisplays();
    const primary = displays.find((d) => d.primary);
    if (!primary) throw new Error("no connected displays reported by the OS");
    return primary;
  }
}

/**
 * Build the input dependency graph. The optional container lets tests inject
 * spies; a fresh one is created when none is supplied.
 */
export function createInputContainer(
  container: ContainerType = new Container(),
): ContainerType {
  container
    .register(monitorToken, () => new ElectronMonitors(), "singleton")
    .register(providerToken, () => createMouseProvider().provider, "singleton")
    .register(keyboardProviderToken, () => createKeyboardProvider().provider, "singleton")
    .register(
      controllerToken,
      (c: ContainerType) =>
        new MouseController({
          provider: c.resolve(providerToken),
          monitors: c.resolve(monitorToken),
        }),
      "singleton",
    )
    .register(
      keyboardControllerToken,
      (c: ContainerType) =>
        new KeyboardController({ provider: c.resolve(keyboardProviderToken) }),
      "singleton",
    );
  return container;
}

/**
 * Build the input service for the production receiver: real provider, real
 * monitors, and a session lookup that reads from the gateway's auth state.
 */
export function createInputService(
  container: ContainerType = createInputContainer(),
  sessionLookup: (
    sessionId: string,
  ) => import("@kbm-remote/network").GatewaySession | undefined,
): InputService {
  return new InputService(
    container.resolve(controllerToken),
    sessionLookup,
    undefined,
    container.resolve(keyboardControllerToken),
  );
}
