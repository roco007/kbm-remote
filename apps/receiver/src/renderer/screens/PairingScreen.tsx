/**
 * Pairing — shows the receiver's pairing code (with QR) and the queue of
 * pending sender requests (UX §4 R3). A 6-digit code is always valid for the
 * current pairing window; senders can either type the code or scan the QR.
 */
import { toDataURL } from "qrcode";
import { useEffect, useRef, useState } from "react";

import {
  Card,
  EmptyState,
  M3Button,
  M3Chip,
  M3Field,
  ScreenShell,
  useTokens,
} from "../primitives";
import { useAppStore } from "../store";

export function PairingScreen() {
  const toks = useTokens();
  const store = useAppStore();
  const [code, setCode] = useState<string>("");
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const codeRef = useRef<string>("");

  useEffect(() => {
    void loadCode();
  }, []);

  async function loadCode() {
    const c = await store.pairingCode();
    codeRef.current = c;
    setCode(c);
    setQrDataUrl(await toDataURL(`kbmremote://pair/${c}`, { margin: 1, scale: 6 }));
  }

  return (
    <ScreenShell
      title="Pairing"
      subtitle="Show the code to the sender, or approve a device that is waiting below."
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(280px, 360px) 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        {/* ── Pairing code + QR ───────────────────────────────────── */}
        <Card title="Pair this sender">
          <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
            <div
              style={{
                fontSize: 30,
                fontWeight: 700,
                letterSpacing: "0.35em",
                fontVariantNumeric: "tabular-nums",
                color: "var(--accent)",
              }}
            >
              {code || "———"}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 6 }}>
              Valid for 5 minutes · refresh to regenerate
            </div>
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="Pairing QR code"
                style={{
                  width: 200,
                  height: 200,
                  margin: "14px auto 0",
                  background: "#FFFFFF",
                  padding: 8,
                  borderRadius: toks.radiusLg,
                  border: "1px solid var(--border)",
                }}
              />
            ) : null}
            <div
              style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 16 }}
            >
              <M3Button variant="outlined" onClick={() => void loadCode()}>
                Refresh code
              </M3Button>
            </div>
          </div>
        </Card>

        {/* ── Pending requests ────────────────────────────────────── */}
        <Card
          title={`Pairing requests (${store.pending.length})`}
          actions={
            store.pending.length > 0 ? (
              <M3Chip label="Waiting for approval" tone="warning" />
            ) : (
              <M3Chip label="None" tone="default" />
            )
          }
        >
          {store.pending.length === 0 ? (
            <EmptyState
              icon="🕐"
              title="No pending requests"
              description="When a sender enters this receiver's IP it will appear here awaiting approval."
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {store.pending.map((device) => (
                <div
                  key={device.deviceId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    background: "var(--bg-app)",
                    border: "1px solid var(--border)",
                    borderRadius: toks.radiusMd,
                    padding: "12px 14px",
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
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                      {device.deviceName}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                      {device.deviceOs || "unknown os"} · received{" "}
                      {new Date(
                        (device as { receivedAt?: number }).receivedAt ?? Date.now(),
                      ).toLocaleTimeString()}
                    </div>
                  </div>
                  <M3Button
                    variant="text"
                    onClick={() => {
                      void store.revokeDevice(device.deviceId);
                    }}
                  >
                    Deny
                  </M3Button>
                  <M3Button
                    onClick={() => {
                      void store.approveDevice(device.deviceId);
                    }}
                  >
                    Approve
                  </M3Button>
                </div>
              ))}
            </div>
          )}

          {/* Manual code verify (diagnostic entry point). */}
          <div
            style={{
              borderTop: "1px solid var(--border)",
              marginTop: 18,
              paddingTop: 14,
              display: "flex",
              gap: 8,
              alignItems: "flex-end",
            }}
          >
            <M3Field
              label="Manual pairing code"
              value={input}
              onChange={setInput}
              placeholder="123456"
              style={{ flex: 1, maxWidth: 220 }}
            />
            <M3Button
              variant="outlined"
              disabled={input.replace(/\D/g, "").length !== 6}
              onClick={async () => {
                setFeedback(null);
                if (input.replace(/\s/g, "").toUpperCase() === codeRef.current) {
                  setFeedback("Valid — the sender may continue.");
                } else {
                  setFeedback("Invalid code. Show the current code on the left.");
                }
                setTimeout(() => setFeedback(null), 4000);
              }}
            >
              Verify
            </M3Button>
            {feedback ? (
              <span style={{ fontSize: 12, color: "var(--warning)" }}>{feedback}</span>
            ) : null}
          </div>
        </Card>
      </div>
    </ScreenShell>
  );
}
