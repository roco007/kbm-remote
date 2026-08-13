/**
 * Preload bridge — the sandbox-safe API surface the dashboard renderer may
 * call. Everything here is `contextBridge.exposeInMainWorld`; the renderer
 * process has no direct Node or Electron access.
 *
 * Mirrors the IPC channels registered in main/index.ts (see
 * apps/receiver/src/main/index.ts `registerIpc`).
 */
import { contextBridge, ipcRenderer } from "electron";

import type { AppSettings, DeviceEntry, DevicePermission, LogEntry } from "../main";

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

export interface ServiceStatus {
  running: boolean;
  port: number | null;
  deviceId: string | null;
  fingerprint: string | null;
  sessionCount: number;
}

export interface ReceiverApi {
  settings: {
    get: () => Promise<AppSettings>;
    update: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  };
  service: {
    start: () => Promise<ServiceStatus>;
    stop: () => Promise<ServiceStatus>;
    status: () => Promise<ServiceStatus>;
    /** Fired when the service state changes (start/stop from tray etc.). */
    onStateChanged: (listener: () => void) => () => void;
  };
  devices: {
    list: () => Promise<DeviceEntry[]>;
    pending: () => Promise<DeviceEntry[]>;
    approve: (deviceId: string) => Promise<DeviceEntry[]>;
    revoke: (deviceId: string) => Promise<DeviceEntry[]>;
    setPermissions: (
      deviceId: string,
      permissions: DevicePermission[],
    ) => Promise<DeviceEntry[]>;
    /** Fired when the device list changes. */
    onChanged: (listener: () => void) => () => void;
  };
  pairing: {
    code: () => Promise<string>;
  };
  sessions: {
    list: () => Promise<SessionView[]>;
  };
  logs: {
    tail: (limit: number) => Promise<LogEntry[]>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
  };
  /** Fired when settings change from another window/tray. */
  onSettingsChanged: (listener: () => void) => () => void;
}

const api: ReceiverApi = {
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (patch) => ipcRenderer.invoke("settings:update", patch),
  },
  service: {
    start: () => ipcRenderer.invoke("service:start"),
    stop: () => ipcRenderer.invoke("service:stop"),
    status: () => ipcRenderer.invoke("service:status"),
    onStateChanged: (listener) => {
      const handler = () => listener();
      ipcRenderer.on("serviceStateChanged", handler);
      return () => ipcRenderer.off("serviceStateChanged", handler);
    },
  },
  devices: {
    list: () => ipcRenderer.invoke("devices:list"),
    pending: () => ipcRenderer.invoke("devices:pending"),
    approve: (deviceId) => ipcRenderer.invoke("devices:approve", deviceId),
    revoke: (deviceId) => ipcRenderer.invoke("devices:revoke", deviceId),
    setPermissions: (deviceId, permissions) =>
      ipcRenderer.invoke("devices:setPermissions", deviceId, permissions),
    onChanged: (listener) => {
      const handler = () => listener();
      ipcRenderer.on("devicesChanged", handler);
      return () => ipcRenderer.off("devicesChanged", handler);
    },
  },
  pairing: {
    code: () => ipcRenderer.invoke("pairing:code"),
  },
  sessions: {
    list: () => ipcRenderer.invoke("sessions:list"),
  },
  logs: {
    tail: (limit) => ipcRenderer.invoke("logs:tail", limit),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  },
  onSettingsChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("settingsChanged", handler);
    return () => ipcRenderer.off("settingsChanged", handler);
  },
};

contextBridge.exposeInMainWorld("kbmReceiver", api);
