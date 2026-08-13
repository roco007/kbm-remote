/**
 * Connection store (Zustand) — owns the singleton ConnectionManager and
 * mirrors its event stream into an easily-consumed slice.
 *
 * Paired devices are persisted to AsyncStorage (`kbm.devices.v1`). The
 * manager is created lazily the first time a screen subscribes with
 * `get().ensureManager()` — the React runtime must have installed
 * `global.WebSocket` before then (Expo guarantees this at JS bundle time).
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";

import { ConnectionManager } from "../services/connectionManager";

import type { ClientState } from "@kbm-remote/network";

export interface PairedDevice {
  /** Stable id — sha-256 of host:port to avoid duplicates after renames. */
  id: string;
  /** User-facing label (e.g. "Raj's MacBook"). */
  name: string;
  host: string;
  port: number;
  /** Assigned once a HelloAck/AuthOk completes; used for token resume. */
  sessionId?: string;
  sessionToken?: string;
}

export interface ConnectionState {
  manager: ConnectionManager | null;
  state: ClientState;
  devices: PairedDevice[];
  /** Device currently being connected to (for status UI). */
  target: PairedDevice | null;
  error: string | null;

  ensureManager: () => ConnectionManager;
  saveDevice: (device: PairedDevice) => Promise<void>;
  removeDevice: (id: string) => Promise<void>;
  connect: (device: PairedDevice) => Promise<void>;
  disconnect: () => void;
  dispose: () => void;
}

const DEVICES_KEY = "kbm.devices.v1";

export function deviceKey(host: string, port: number): string {
  // Deterministic id from host:port — the receiver advertises itself by
  // address, so the address is the natural identity until QR identity lands.
  return `${host}:${port}`;
}

async function loadDevices(): Promise<PairedDevice[]> {
  try {
    const raw = await AsyncStorage.getItem(DEVICES_KEY);
    const parsed = raw ? (JSON.parse(raw) as PairedDevice[]) : [];
    return parsed.filter(
      (d) => d && typeof d.host === "string" && typeof d.port === "number",
    );
  } catch {
    return [];
  }
}

async function persistDevices(devices: PairedDevice[]): Promise<void> {
  try {
    await AsyncStorage.setItem(DEVICES_KEY, JSON.stringify(devices));
  } catch {
    /* persistence is best-effort */
  }
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  manager: null,
  state: "idle",
  devices: [],
  target: null,
  error: null,

  ensureManager: () => {
    let { manager } = get();
    if (manager) return manager;
    // Lazy singletons: one manager per app lifetime; dispose() ends it.
    manager = new ConnectionManager({
      clientName: "KBM Remote",
      clientOs: "android",
      socketFactory: (url, protocols) =>
        new globalThis.WebSocket(
          url,
          protocols,
        ) as unknown as import("@kbm-remote/network").ClientSocket,
      // Resume credentials are re-attached per-connect below.
    });
    manager.on("stateChange", (state) => {
      set({ state });
      // If the manager has settled into disconnected/failed after a target,
      // surface a hint while keeping the exact wire state authoritative.
      if (state === "disconnected" && get().target) {
        set({ error: "Disconnected from receiver" });
      }
    });
    manager.on("authOk", (payload) => {
      // Persist resume credentials for the target device (token reuse, §5.4).
      const target = get().target;
      if (target && payload && typeof payload.sessionToken === "string") {
        void get().saveDevice({
          ...target,
          sessionToken: payload.sessionToken as string,
        });
      }
    });
    manager.on("authFailed", () => {
      set({ error: "Receiver rejected this device — re-pair it." });
    });
    manager.on("message", () => {
      /* Input frames are fire-and-forget; the slice only needs the event for tests. */
    });
    set({ manager });
    void (async () => {
      set({ devices: await loadDevices() });
    })();
    return manager;
  },

  saveDevice: async (device) => {
    const next = [...get().devices.filter((d) => d.id !== device.id), device];
    set({ devices: next });
    await persistDevices(next);
  },

  removeDevice: async (id) => {
    const next = get().devices.filter((d) => d.id !== id);
    set({ devices: next });
    await persistDevices(next);
  },

  connect: async (device) => {
    const manager = get().ensureManager();
    set({ target: device, error: null });
    try {
      await manager.connect({
        url: `wss://${device.host}:${device.port}`,
        source: "manual",
      });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  disconnect: () => {
    const { manager } = get();
    if (manager) manager.disconnect();
    set({ target: null, error: null });
  },

  dispose: () => {
    const { manager } = get();
    if (manager) manager.dispose();
    set({ manager: null, state: "idle" });
  },
}));
