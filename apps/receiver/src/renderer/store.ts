/**
 * Dashboard state — Zustand store mirroring the preload bridge
 * (`window.kbmReceiver`). Hydrates on mount; screens subscribe to the slices
 * they render. Dark mode follows `settings.theme === "dark"` (or "system" →
 * matched against `prefers-color-scheme`).
 */
import { create } from "zustand";

import type { AppSettings, DeviceEntry, LogEntry } from "../main";
import type { ServiceStatus } from "../preload";

declare global {
  interface Window {
    kbmReceiver: import("../preload").ReceiverApi;
  }
}

function api() {
  return window.kbmReceiver;
}

export interface SessionView {
  sessionId: string;
  deviceName: string;
  deviceOs: string;
  connectedAt: number;
  lastPongTs: number;
  rttMs: number;
  jitterMs: number;
  authenticated: boolean;
  permissions: string[];
  missedPongs: number;
}

export interface ConnectionState {
  settings: AppSettings | null;
  service: ServiceStatus | null;
  devices: DeviceEntry[];
  pending: DeviceEntry[];
  sessions: SessionView[];
  logs: LogEntry[];
  /** Set once the initial hydration completes. */
  hydrated: boolean;
  error: string | null;
}

export type AppStore = ConnectionState & {
  hydrate: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshLogs: (limit?: number) => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  approveDevice: (deviceId: string) => Promise<DeviceEntry[]>;
  revokeDevice: (deviceId: string) => Promise<DeviceEntry[]>;
  setDevicePermissions: (
    deviceId: string,
    permissions: string[],
  ) => Promise<DeviceEntry[]>;
  startService: () => Promise<ServiceStatus>;
  stopService: () => Promise<ServiceStatus>;
  pairingCode: () => Promise<string>;
};

export const useAppStore = create<AppStore>((set, get) => ({
  settings: null,
  service: null,
  devices: [],
  pending: [],
  sessions: [],
  logs: [],
  hydrated: false,
  error: null,

  hydrate: async () => {
    try {
      const [settings, service, devices, pending, logs] = await Promise.all([
        api().settings.get(),
        api().service.status(),
        api().devices.list(),
        api().devices.pending(),
        api().logs.tail(200),
      ]);
      set({ settings, service, devices, pending, logs, hydrated: true, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  refreshSessions: async () => {
    try {
      const sessions = await api().sessions.list();
      set({ sessions });
    } catch {
      // Stale sessions are acceptable; the next poll refreshes.
    }
  },

  refreshLogs: async (limit = 200) => {
    try {
      set({ logs: await api().logs.tail(limit) });
    } catch {
      // Log view degradation is non-fatal.
    }
  },

  updateSettings: async (patch) => {
    const next = await api().settings.update(patch);
    set({ settings: next });
    return next;
  },

  approveDevice: async (deviceId) => {
    const devices = await api().devices.approve(deviceId);
    set({ devices, pending: await api().devices.pending() });
    return devices;
  },

  revokeDevice: async (deviceId) => {
    const devices = await api().devices.revoke(deviceId);
    set({ devices });
    void get().refreshSessions();
    return devices;
  },

  setDevicePermissions: async (deviceId, permissions) => {
    const devices = await api().devices.setPermissions(deviceId, permissions as never);
    set({ devices });
    return devices;
  },

  startService: async () => {
    const service = await api().service.start();
    set({ service });
    void get().refreshSessions();
    return service;
  },

  stopService: async () => {
    const service = await api().service.stop();
    set({ service, sessions: [] });
    return service;
  },

  pairingCode: () => api().pairing.code(),
}));

/** Resolve the effective theme mode: "system" follows the OS preference. */
export function resolveThemeMode(mode: "system" | "light" | "dark"): "light" | "dark" {
  if (mode === "system") {
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "light";
  }
  return mode;
}
