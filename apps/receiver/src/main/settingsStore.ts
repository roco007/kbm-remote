/**
 * Settings store — JSON-persisted application settings under
 * `app.getPath("userData")`. Pure TS, fully unit-testable without Electron.
 *
 * The receiver's default posture is "always listening" (port 27001), close-to-
 * tray enabled, and system theme. Every key is typed; the renderer never
 * invents settings, it only patches known fields.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface AppSettings {
  theme: "system" | "light" | "dark";
  port: number;
  deviceId: string;
  autoStart: boolean;
  closeToTray: boolean;
  autoApproveTrusted: boolean;
  /** Persist path for the device registry (set by the Electron layer). */
  registryPath: string;
  /** Last bound port / fingerprint captured at service start. */
  lastPort: number | null;
  fingerprint: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  port: 27001,
  deviceId: hostnameLabel(),
  autoStart: false,
  closeToTray: true,
  autoApproveTrusted: true,
  registryPath: "",
  lastPort: null,
  fingerprint: null,
};

function hostnameLabel(): string {
  try {
    const os = require("node:os") as typeof import("node:os");
    return os.hostname().slice(0, 32) || "kbm-receiver";
  } catch {
    return "kbm-receiver";
  }
}

export interface SettingsStore<T> {
  get(): T;
  /** Atomically replace settings and persist. Returns the new snapshot. */
  apply(mutator: (current: T) => T): T;
}

export function createSettingsStore<T>(
  path: string,
  defaults: T = DEFAULT_SETTINGS as unknown as T,
): SettingsStore<T> {
  let current: T = defaults;
  if (path && existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      current = { ...defaults, ...(parsed && typeof parsed === "object" ? parsed : {}) };
    } catch {
      // Corrupt file — fall back to defaults; never crash the shell.
      current = defaults;
    }
  }

  const persist = () => {
    try {
      writeFileSync(path, JSON.stringify(current, null, 2));
    } catch {
      // Write failures degrade to in-memory settings — the app stays usable.
    }
  };

  return {
    get: () => current,
    apply: (mutator) => {
      current = mutator(current);
      persist();
      return current;
    },
  };
}
