/**
 * Renderer entry — the receiver dashboard React app.
 *
 * Mounts the sidebar-navigated shell with per-route screens, global M3
 * motion keyframes, and a `TokenProvider` driven by the persisted theme
 * setting ("system" follows the OS).
 */
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { Sidebar, TokenProvider } from "./primitives";
import { DashboardScreen } from "./screens/DashboardScreen";
import { LogsScreen } from "./screens/LogsScreen";
import { PairingScreen } from "./screens/PairingScreen";
import { PermissionsScreen } from "./screens/PermissionsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { resolveThemeMode, useAppStore } from "./store";

const GLOBAL_STYLES = `
  html, body, #root { height: 100%; margin: 0; }
  body { overflow: hidden; }
  #root { overflow-y: auto; }
  ::-webkit-scrollbar { width: 8px; }
  ::-webkit-scrollbar-thumb { background: var(--outline); border-radius: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes scaleIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
`;

type RouteId = "dashboard" | "pairing" | "permissions" | "logs" | "settings";

export function App() {
  const store = useAppStore();
  const [route, setRoute] = useState<RouteId>("dashboard");

  useEffect(() => {
    void store.hydrate();
    const offService = window.kbmReceiver.service.onStateChanged(() => {
      void store.refreshSessions();
    });
    const offDevices = window.kbmReceiver.devices.onChanged(() => {
      void store.hydrate();
    });
    const offSettings = window.kbmReceiver.onSettingsChanged(() => {
      void store.hydrate();
    });
    return () => {
      offService();
      offDevices();
      offSettings();
    };
  }, []);

  const mode = resolveThemeMode(store.settings?.theme ?? "system");

  const pendingBadge = store.pending.length;
  const navItems = useMemo(
    () => [
      { id: "dashboard" as const, label: "Dashboard", icon: "🖥" },
      {
        id: "pairing" as const,
        label: "Pairing",
        icon: "🔗",
        badge: pendingBadge || undefined,
      },
      { id: "permissions" as const, label: "Permissions", icon: "🔐" },
      { id: "logs" as const, label: "Logs", icon: "📜" },
      { id: "settings" as const, label: "Settings", icon: "⚙" },
    ],
    [pendingBadge],
  );

  const screen =
    route === "pairing" ? (
      <PairingScreen />
    ) : route === "permissions" ? (
      <PermissionsScreen />
    ) : route === "logs" ? (
      <LogsScreen />
    ) : route === "settings" ? (
      <SettingsScreen />
    ) : (
      <DashboardScreen />
    );

  return (
    <TokenProvider mode={mode}>
      <style>{GLOBAL_STYLES}</style>
      <div style={{ display: "flex", height: "100vh" }}>
        <Sidebar
          items={navItems}
          active={route}
          onChange={(id) => setRoute(id as RouteId)}
        />
        <main style={{ flex: 1, overflowY: "auto" }}>{screen}</main>
      </div>
    </TokenProvider>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
