/**
 * Electron main process — the KBM Remote desktop receiver shell.
 *
 * Responsibilities (Architecture §6, UX §4 R1–R12):
 *   - Bootstrap the NestJS application context in-process (network service)
 *   - Create the single dashboard window (responsive, native frame hidden in
 *     tray-icon mode) and wire it to `index.html` via the bundled renderer
 *   - Create the system tray icon and menu (show/hide, quit, connection
 *     status, open settings)
 *   - Register auto-start with the OS login item (Electron `app.setLoginItemSettings`)
 *   - Persist settings + device registry + log buffer under
 *     `app.getPath("userData")` and surface them over the preload bridge
 *   - Drive the `NetworkService`: start/stop, paired device approval and
 *     revocation, permission editing
 *
 * Main ↔ renderer communication uses `contextBridge` (see preload/index.ts)
 * — no remote module, no eval, no Node access from the dashboard process.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  shell,
  type NativeImage,
} from "electron";

import {
  createDeviceRegistry,
  PERMISSIONS,
  type DeviceEntry,
  type DevicePermission,
} from "./deviceRegistry";
import { createLogBuffer, type LogEntry } from "./logBuffer";
import { NetworkService } from "./networkService";
import { createSettingsStore, DEFAULT_SETTINGS, type AppSettings } from "./settingsStore";

const logBuffer = createLogBuffer(2_000);
const settingsPath = join(app.getPath("userData"), "settings.json");
mkdirSync(app.getPath("userData"), { recursive: true });

const settingsStore = createSettingsStore(settingsPath, DEFAULT_SETTINGS);
const registry = createDeviceRegistry();
let networkService: NetworkService | null = null;
let tray: Tray | null = null;
const mainWindow: BrowserWindow | null = null;

function iconPath(): string {
  // Tray/dock icon shipped alongside the bundled renderer. In dev the build
  // folder may be missing; fall back to a transparent 1×1 to keep CI green.
  const candidate = join(__dirname, "..", "renderer", "icon.png");
  return existsSync(candidate) ? candidate : "";
}

// ── Window ──────────────────────────────────────────────────────────────

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: "KBM Remote — Receiver",
    backgroundColor: settingsStore.get().theme === "dark" ? "#0F1115" : "#F7F8FA",
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses require('electron'); contextBridge isolates
    },
  });

  void win.loadFile(join(__dirname, "..", "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());

  win.on("close", (event) => {
    // Tray icon mode: hide instead of quit (UX §4 R1).
    if (settingsStore.get().closeToTray && tray) {
      event.preventDefault();
      win.hide();
    }
  });

  // Follow system theme changes live.
  const onThemeChanged = () =>
    void settingsStore.apply((s) => ({ ...s, theme: "system" }));
  nativeThemeHandlers(win, onThemeChanged);

  return win;
}

function nativeThemeHandlers(win: BrowserWindow, onChange: () => void) {
  const { nativeTheme } = require("electron") as typeof import("electron");
  nativeTheme.on("updated", onChange);
  win.on("closed", () => nativeTheme.off("updated", onChange));
}

// ── Tray ────────────────────────────────────────────────────────────────

function createTray(): void {
  const raw = iconPath();
  const image = raw ? nativeImage.createFromPath(raw) : nativeImage.createEmpty();
  if (raw) image.setTemplateImage(true);
  tray = new Tray(image.isEmpty() ? defaultTrayImage() : image);
  tray.setToolTip("KBM Remote Receiver");
  refreshTrayMenu();
  tray.on("double-click", () => mainWindow?.show());
}

function defaultTrayImage(): NativeImage {
  // A tray glyph PNG is bundled by the build; if missing we fall back to an
  // empty image — the tooltip still conveys connection state.
  return nativeImage.createEmpty();
}

function refreshTrayMenu(): void {
  if (!tray) return;
  const connected = networkService ? networkService.sessionCount : 0;
  const status =
    connected > 0
      ? `${connected} device${connected === 1 ? "" : "s"} connected`
      : "No devices connected";
  const ctxMenu = Menu.buildFromTemplate([
    { label: "KBM Remote Receiver", enabled: false },
    { type: "separator" },
    { label: status, enabled: false },
    {
      label: "Show Dashboard",
      click: () => mainWindow?.show(),
    },
    { type: "separator" },
    {
      label: networkService ? "Stop Receiver" : "Start Receiver",
      click: () => {
        void (async () => {
          try {
            if (networkService) await networkService.stop();
            else await startNetworkService();
            refreshTrayMenu();
            void mainWindow?.webContents.send("serviceStateChanged");
          } catch (err) {
            logBuffer.warn("tray", `service toggle failed: ${String(err)}`);
          }
        })();
      },
    },
    { type: "separator" },
    {
      label: "Start with system",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        const wanted = menuItem.checked === true;
        app.setLoginItemSettings({ openAtLogin: wanted, openAsHidden: wanted });
        logBuffer.info("auto-start", `login item ${wanted ? "enabled" : "disabled"}`);
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        void (async () => {
          await networkService?.stop();
          app.quit();
        })();
      },
    },
  ]);
  tray.setContextMenu(ctxMenu);
}

// ── Network service lifecycle ───────────────────────────────────────────

async function startNetworkService(): Promise<void> {
  if (networkService) return;
  const s = settingsStore.get();
  networkService = new NetworkService({
    port: s.port,
    deviceId: s.deviceId,
    authStore: registry.toAuthStore(),
    // Persistent TLS identity (§3.1): the receiver keeps the same key+cert
    // across restarts, so the pairing QR fingerprint is stable and a MITM
    // cannot substitute its own certificate after first pairing.
    identityDir: app.getPath("userData"),
  });

  // Surface registry events (pair requests, approvals, revocations) in the log.
  registry.on("pairRequest", (req) =>
    logBuffer.info("pairing", `pair request from ${req.clientName} (${req.clientOs})`),
  );
  registry.on("deviceApproved", (d) =>
    logBuffer.info("devices", `device ${d.deviceId} approved`),
  );
  registry.on("deviceRevoked", (d) =>
    logBuffer.info("devices", `device ${d.deviceId} revoked`),
  );

  const meta = await networkService.start();
  logBuffer.info(
    "network",
    `receiver listening on 0.0.0.0:${meta.port} (deviceId=${meta.deviceId})`,
  );
  void settingsStore.apply((cur) => ({
    ...cur,
    lastPort: meta.port,
    fingerprint: meta.fingerprint,
  }));
}

async function stopNetworkService(): Promise<void> {
  await networkService?.stop();
  networkService = null;
  refreshTrayMenu();
  logBuffer.info("network", "receiver service stopped");
}

// ── IPC surface (see preload/index.ts for the renderer-side API) ────────

function registerIpc(): void {
  // Settings — the dashboard toggles dark mode, auto-start, close-to-tray…
  ipcMain.handle("settings:get", () => settingsStore.get());
  ipcMain.handle("settings:update", (_e, patch: Partial<AppSettings>) => {
    const next = settingsStore.apply((cur) => ({ ...cur, ...patch }));
    if (patch.autoStart !== undefined) {
      app.setLoginItemSettings({
        openAtLogin: patch.autoStart,
        openAsHidden: patch.autoStart,
      });
    }
    refreshTrayMenu();
    void mainWindow?.webContents.send("settingsChanged");
    return next;
  });

  // Service — start/stop/status.
  ipcMain.handle("service:start", async () => {
    await startNetworkService();
    refreshTrayMenu();
    return serviceStatus();
  });
  ipcMain.handle("service:stop", async () => {
    await stopNetworkService();
    return serviceStatus();
  });
  ipcMain.handle("service:status", () => serviceStatus());

  // Device list + pairing decisions.
  ipcMain.handle("devices:list", () => registry.list());
  ipcMain.handle("devices:pending", () => registry.pending());
  ipcMain.handle("devices:approve", async (_e, deviceId: string) => {
    registry.approve(deviceId);
    void mainWindow?.webContents.send("devicesChanged");
    return registry.list();
  });
  ipcMain.handle("devices:revoke", async (_e, deviceId) => {
    const devId = String(deviceId);
    registry.revoke(devId);
    await registry.persist(settingsStore.get().registryPath);
    refreshTrayMenu();
    void mainWindow?.webContents.send("devicesChanged");
    return registry.list();
  });
  ipcMain.handle("devices:setPermissions", async (_e, deviceId, permissions) => {
    const devId = String(deviceId);
    const perms = (permissions as DevicePermission[]).filter((p) =>
      PERMISSIONS.includes(p),
    );
    registry.setPermissions(devId, perms);
    await registry.persist(settingsStore.get().registryPath);
    void mainWindow?.webContents.send("devicesChanged");
    return registry.list();
  });

  // Live sessions — the connection monitor polls this (UX §4 R12).
  ipcMain.handle("sessions:list", () => listSessions());

  // Pairing code issuance — the pairing screen displays it.
  ipcMain.handle("pairing:code", async () => registry.issuePairingCode());

  // Logs — the logs screen tails this.
  ipcMain.handle("logs:tail", (_e, limit: number) => logBuffer.tail(limit));

  // External links (e.g. docs in settings) — never let the renderer open URLs freely.
  ipcMain.handle("shell:openExternal", (_e, url: string) => {
    if (url.startsWith("https://")) return shell.openExternal(url);
    throw new Error(`refused: ${url}`);
  });
}

interface ServiceStatus {
  running: boolean;
  port: number | null;
  deviceId: string | null;
  fingerprint: string | null;
  sessionCount: number;
}

function serviceStatus(): ServiceStatus {
  return {
    running: networkService !== null,
    port: networkService ? settingsStore.get().lastPort : null,
    deviceId: networkService ? settingsStore.get().deviceId : null,
    fingerprint: networkService ? settingsStore.get().fingerprint : null,
    sessionCount: networkService?.sessionCount ?? 0,
  };
}

interface SessionSnapshot {
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

function listSessions(): SessionSnapshot[] {
  if (!networkService) return [];
  const out: SessionSnapshot[] = [];
  for (const session of networkService.sessions()) {
    const s = session as unknown as {
      metrics: { rtt: number; jitter: number };
      sessionId?: string;
      clientName?: string;
      clientOs?: string;
      deviceName?: string;
      deviceOs?: string;
      connectedAt: number;
      lastPongTs: number;
      authenticated: boolean;
      permissions: string[];
      missedPongs: number;
    };
    out.push({
      sessionId: s.sessionId ?? "",
      deviceName: s.clientName ?? s.deviceName ?? "Unknown device",
      deviceOs: s.clientOs ?? s.deviceOs ?? "",
      connectedAt: s.connectedAt,
      lastPongTs: s.lastPongTs,
      rttMs: Math.round(s.metrics.rtt),
      jitterMs: Math.round(s.metrics.jitter),
      authenticated: s.authenticated,
      permissions: s.permissions ?? [],
      missedPongs: s.missedPongs,
    });
  }
  return out;
}

// ── Bootstrap ───────────────────────────────────────────────────────────

async function main() {
  // Load persisted device registry before the service starts.
  await registry.load(join(app.getPath("userData"), "devices.json"));

  registerIpc();

  await app.whenReady();
  createMainWindow();
  mainWindow?.show();
  createTray();

  // Start the network service immediately (the receiver's whole purpose is
  // to listen — UX onboarding keeps it running from first launch).
  await startNetworkService();
  refreshTrayMenu();

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", async () => {
    await stopNetworkService();
    await registry.persist(settingsStore.get().registryPath);
  });
}

void main();

// Re-export persistence helpers for tests (keeps this file testable).
export { settingsStore, logBuffer, registry, startNetworkService, stopNetworkService };
export type { AppSettings, DeviceEntry, DevicePermission, LogEntry };
