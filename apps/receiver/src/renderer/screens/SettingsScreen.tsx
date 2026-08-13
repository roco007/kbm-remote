/**
 * Settings — receiver configuration (UX §4 R5).
 *
 * Port changes require a service restart; everything else applies live.
 * Dark mode follows the `theme` token ("system" honours the OS preference).
 */
import { useMemo, useState } from "react";

import {
  Card,
  M3Button,
  M3Field,
  M3Select,
  M3Switch,
  M3Chip,
  ScreenShell,
} from "../primitives";
import { useAppStore } from "../store";

export function SettingsScreen() {
  const store = useAppStore();
  const settings = store.settings;
  const [deviceId, setDeviceId] = useState("");
  const [port, setPort] = useState("");
  const [saved, setSaved] = useState(false);

  // Sync local draft state when settings hydrate.
  useMemo(() => {
    if (settings && !deviceId) {
      setDeviceId(settings.deviceId);
      setPort(String(settings.port));
    }
  }, [settings]);

  if (!settings) return null;

  const restartRequired = port !== "" && Number(port) !== settings.port;

  return (
    <ScreenShell
      title="Settings"
      subtitle="Identity, network and behaviour options for this receiver."
      actions={saved ? <M3Chip label="Saved" tone="success" /> : null}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
          gap: 16,
        }}
      >
        <Card title="Identity">
          <M3Field
            label="Device ID"
            value={deviceId}
            onChange={setDeviceId}
            placeholder="my-pc"
            style={{ marginBottom: 14 }}
          />
          <div
            style={{ fontSize: 11.5, color: "var(--text-secondary)", marginBottom: 14 }}
          >
            Shown to senders during discovery. The fingerprint below identifies this
            receiver's TLS certificate.
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Fingerprint:{" "}
            <span style={{ fontFamily: "monospace", color: "var(--text-primary)" }}>
              {settings.fingerprint || "—"}
            </span>
          </div>
        </Card>

        <Card
          title="Network"
          actions={
            restartRequired ? <M3Chip label="Restart needed" tone="warning" /> : null
          }
        >
          <M3Field
            label="Port"
            type="number"
            value={port}
            onChange={setPort}
            placeholder="27001"
            style={{ marginBottom: 14 }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            {restartRequired ? (
              <M3Button
                onClick={async () => {
                  const portNum = Number(port);
                  if (portNum !== settings.port && portNum > 0 && portNum < 65536) {
                    await store.stopService();
                    await store.updateSettings({ port: portNum });
                    await store.startService();
                  }
                  setSaved(true);
                  setTimeout(() => setSaved(false), 2500);
                }}
              >
                Apply &amp; restart
              </M3Button>
            ) : (
              <M3Button
                variant="outlined"
                disabled={!saved}
                onClick={async () => {
                  setSaved(true);
                  setTimeout(() => setSaved(false), 2500);
                }}
              >
                No changes
              </M3Button>
            )}
          </div>
        </Card>

        <Card title="Behaviour">
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <M3Select
              label="Appearance"
              value={settings.theme}
              onChange={(next) =>
                void store.updateSettings({ theme: next as "system" | "light" | "dark" })
              }
              options={[
                { value: "system", label: "System (follow OS)" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Start with system</div>
                <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                  Launch the receiver automatically at login.
                </div>
              </div>
              <M3Switch
                checked={settings.autoStart}
                onChange={(next) => void store.updateSettings({ autoStart: next })}
              />
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Close to tray</div>
                <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                  Keep the receiver running in the background when the window closes.
                </div>
              </div>
              <M3Switch
                checked={settings.closeToTray}
                onChange={(next) => void store.updateSettings({ closeToTray: next })}
              />
            </div>
          </div>
        </Card>
      </div>
    </ScreenShell>
  );
}
