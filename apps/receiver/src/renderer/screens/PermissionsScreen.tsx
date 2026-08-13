/**
 * Permissions — granular, per-device permission management (UX §4 R9).
 *
 * Every trusted device gets its own row with toggles for the protocol's
 * permission scopes: mouse, keyboard, clipboard, media, presentation,
 * fileTransfer. Changes persist through the device registry immediately.
 */
import { useState } from "react";

import { Card, EmptyState, M3Button, M3Switch, ScreenShell } from "../primitives";
import { useAppStore } from "../store";

const PERMISSION_META: {
  key: import("../../main").DevicePermission;
  label: string;
  icon: string;
  description: string;
}[] = [
  {
    key: "mouse",
    label: "Mouse",
    icon: "🖱",
    description: "Movement, clicks, scroll, drag & drop",
  },
  {
    key: "keyboard",
    label: "Keyboard",
    icon: "⌨",
    description: "Key presses, shortcuts, text input",
  },
  {
    key: "clipboard",
    label: "Clipboard",
    icon: "📋",
    description: "Push and pull clipboard contents",
  },
  {
    key: "media",
    label: "Media keys",
    icon: "🎵",
    description: "Volume, mute, playback controls",
  },
  {
    key: "presentation",
    label: "Presentation",
    icon: "📽",
    description: "Slide navigation, remote pointer",
  },
  {
    key: "fileTransfer",
    label: "File transfer",
    icon: "📁",
    description: "Send and receive files",
  },
];

export function PermissionsScreen() {
  const store = useAppStore();
  const [busy, setBusy] = useState<string | null>(null);

  const setPermissions = async (deviceId: string, next: string[]) => {
    setBusy(deviceId);
    try {
      await store.setDevicePermissions(deviceId, next);
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScreenShell
      title="Permissions"
      subtitle="Control what each trusted device may do. Revoking a device disconnects it immediately."
    >
      {store.devices.length === 0 ? (
        <Card>
          <EmptyState
            icon="🔐"
            title="No trusted devices"
            description="Pair a sender first — its permissions appear here once approved."
          />
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {store.devices.map((device) => (
            <Card key={device.deviceId} title={device.deviceName}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                  gap: 10,
                }}
              >
                {PERMISSION_META.map((meta) => {
                  const enabled = device.permissions.includes(meta.key as never);
                  const disabled = busy === device.deviceId;
                  return (
                    <div
                      key={meta.key}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        background: "var(--bg-app)",
                        border: "1px solid var(--border)",
                        borderRadius: 12,
                        padding: "10px 14px",
                        opacity: disabled ? 0.6 : 1,
                        transition: "opacity 150ms ease-out",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 18,
                          width: 24,
                          textAlign: "center",
                          flexShrink: 0,
                        }}
                      >
                        {meta.icon}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{meta.label}</div>
                        <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                          {meta.description}
                        </div>
                      </div>
                      <M3Switch
                        checked={enabled}
                        disabled={disabled}
                        onChange={(next) => {
                          const perms = next
                            ? [...device.permissions, meta.key]
                            : device.permissions.filter((p) => p !== meta.key);
                          void setPermissions(device.deviceId, perms);
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  borderTop: "1px solid var(--border)",
                  marginTop: 14,
                  paddingTop: 12,
                }}
              >
                <M3Button
                  variant="danger"
                  onClick={() => {
                    void store.revokeDevice(device.deviceId);
                  }}
                >
                  Revoke device
                </M3Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </ScreenShell>
  );
}
