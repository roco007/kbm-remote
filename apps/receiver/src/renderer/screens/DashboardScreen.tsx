/**
 * Dashboard — the receiver's home screen (UX §4 R2/R12).
 *
 * Combines the trusted-device list with the live connection monitor: each
 * connected session shows its RTT, jitter and permission summary. The service
 * status bar at the top mirrors the tray menu ("listening on :27001").
 */
import { useEffect, useRef } from "react";

import {
  Card,
  EmptyState,
  M3Button,
  M3Chip,
  M3IconButton,
  ScreenShell,
  useTokens,
} from "../primitives";
import { useAppStore } from "../store";

export function DashboardScreen() {
  const toks = useTokens();
  const store = useAppStore();

  // Poll sessions every 1.5 s for the live connection monitor.
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    store.refreshSessions();
    timerRef.current = setInterval(() => {
      void store.refreshSessions();
    }, 1500);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const svc = store.service;
  const connectedIds = new Set(store.sessions.map((s) => s.sessionId));

  return (
    <ScreenShell
      title="Dashboard"
      subtitle={
        svc?.running
          ? `Receiver listening on 0.0.0.0:${svc.port ?? "—"} · ${svc.sessionCount} device${svc.sessionCount === 1 ? "" : "s"} connected`
          : "Receiver service is stopped"
      }
      actions={
        svc?.running ? (
          <M3Button variant="outlined" onClick={() => void store.stopService()}>
            Stop Receiver
          </M3Button>
        ) : (
          <M3Button onClick={() => void store.startService()}>Start Receiver</M3Button>
        )
      }
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: 16,
        }}
      >
        {/* ── Trusted devices ─────────────────────────────────────── */}
        <Card
          title={`Trusted devices (${store.devices.length})`}
          actions={
            <M3Chip
              label={svc?.running ? "Listening" : "Stopped"}
              tone={svc?.running ? "success" : "warning"}
            />
          }
        >
          {store.devices.length === 0 ? (
            <EmptyState
              icon="📱"
              title="No trusted devices yet"
              description="Pair a sender from the Pairing screen to add it here."
            />
          ) : (
            store.devices.map((device) => {
              const session = store.sessions.find(
                (s) => s.sessionId === device.sessionId && connectedIds.has(s.sessionId),
              );
              return (
                <div
                  key={device.deviceId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 0",
                    borderTop: "1px solid var(--border)",
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: "50%",
                      background: "var(--on-surface-variant)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 16,
                      flexShrink: 0,
                    }}
                  >
                    {device.deviceOs === "ios" ? "🍎" : "🤖"}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13.5,
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {device.deviceName}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                      {device.deviceOs || "unknown os"} · approved{" "}
                      {new Date(device.approvedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 4,
                      flexWrap: "wrap",
                      justifyContent: "flex-end",
                    }}
                  >
                    <M3Chip
                      label={session ? `${session.rttMs} ms` : "offline"}
                      tone={
                        session
                          ? session.rttMs <= 25
                            ? "success"
                            : session.rttMs <= 75
                              ? "warning"
                              : "danger"
                          : "default"
                      }
                    />
                    <M3IconButton
                      tone="danger"
                      title={`Revoke ${device.deviceName}`}
                      onClick={() => {
                        void store.revokeDevice(device.deviceId);
                      }}
                    >
                      🗑
                    </M3IconButton>
                  </div>
                </div>
              );
            })
          )}
        </Card>

        {/* ── Live connection monitor ─────────────────────────────── */}
        <Card
          title="Active sessions"
          actions={<M3Chip label={`${store.sessions.length} live`} tone="accent" />}
        >
          {store.sessions.length === 0 ? (
            <EmptyState
              icon="🔌"
              title="No active sessions"
              description="Connections from paired senders appear here in real time."
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {store.sessions.map((session) => (
                <div
                  key={session.sessionId}
                  style={{
                    background: "var(--bg-app)",
                    border: `1px solid var(--border)`,
                    borderRadius: toks.radiusMd,
                    padding: "10px 14px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                      {session.deviceName}{" "}
                      <span
                        style={{
                          fontWeight: 400,
                          color: "var(--text-secondary)",
                          fontSize: 11.5,
                        }}
                      >
                        {session.deviceOs}
                      </span>
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                      RTT {session.rttMs} ms · jitter {session.jitterMs} ms
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                    <M3Chip
                      label={session.authenticated ? "Authenticated" : "Unauthenticated"}
                      tone={session.authenticated ? "success" : "warning"}
                    />
                    {session.permissions.map((p) => (
                      <M3Chip key={p} label={p} tone="accent" />
                    ))}
                    {session.missedPongs > 0 ? (
                      <M3Chip
                        label={`${session.missedPongs} missed pong${session.missedPongs === 1 ? "" : "s"}`}
                        tone="danger"
                      />
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </ScreenShell>
  );
}
