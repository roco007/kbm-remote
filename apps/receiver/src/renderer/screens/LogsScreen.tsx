/**
 * Logs — diagnostic event view (UX §4 R8). The main process keeps a rolling
 * 2 000-entry ring buffer; this screen tails it and lets operators filter by
 * level and category, plus refresh on demand.
 */
import { useEffect, useRef, useState } from "react";

import {
  Card,
  M3Button,
  M3Chip,
  M3IconButton,
  M3Select,
  ScreenShell,
} from "../primitives";
import { useAppStore } from "../store";

const LEVELS = ["all", "info", "warn", "error"] as const;
type LevelFilter = (typeof LEVELS)[number];

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function LogsScreen() {
  const store = useAppStore();
  const [level, setLevel] = useState<LevelFilter>("all");
  const [category, setCategory] = useState<string>("all");
  const [autoTail, setAutoTail] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void store.refreshLogs(200);
    if (!autoTail) return;
    timerRef.current = setInterval(() => void store.refreshLogs(200), 2000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [autoTail]);

  const categories = Array.from(new Set(store.logs.map((l) => l.category)));

  const visible = store.logs.filter(
    (entry) =>
      (level === "all" || entry.level === level) &&
      (category === "all" || entry.category === category),
  );

  return (
    <ScreenShell
      title="Logs"
      subtitle={`Showing ${visible.length} of ${store.logs.length} recent entries`}
      actions={
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <M3Chip
            label={autoTail ? "Auto-tail on" : "Auto-tail off"}
            tone={autoTail ? "accent" : "default"}
            onClick={() => setAutoTail(!autoTail)}
          />
          <M3IconButton title="Refresh" onClick={() => void store.refreshLogs(200)}>
            ↻
          </M3IconButton>
        </div>
      }
    >
      <Card>
        <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
          <M3Select
            label="Level"
            value={level}
            onChange={(v) => setLevel(v as LevelFilter)}
            options={LEVELS.map((l) => ({
              value: l,
              label: l === "all" ? "All levels" : l.toUpperCase(),
            }))}
            style={{ width: 150 }}
          />
          <M3Select
            label="Category"
            value={category}
            onChange={setCategory}
            options={[
              { value: "all", label: "All categories" },
              ...categories.map((c) => ({ value: c, label: c })),
            ]}
            style={{ width: 180 }}
          />
          <div style={{ flex: 1 }} />
          <M3Button variant="outlined" onClick={() => void store.refreshLogs(200)}>
            Refresh
          </M3Button>
        </div>
        {visible.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: 30,
              color: "var(--text-secondary)",
              fontSize: 13,
            }}
          >
            No log entries match the current filters.
          </div>
        ) : (
          <div
            style={{
              maxHeight: 480,
              overflowY: "auto",
              border: "1px solid var(--border)",
              borderRadius: 12,
              background: "var(--bg-app)",
            }}
          >
            {visible.map((entry, i) => (
              <div
                key={`${entry.ts}-${i}`}
                style={{
                  display: "flex",
                  gap: 12,
                  padding: "7px 14px",
                  fontSize: 12.5,
                  borderBottom: "1px solid var(--border)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <span
                  style={{ width: 64, color: "var(--text-secondary)", flexShrink: 0 }}
                >
                  {timeAgo(entry.ts)}
                </span>
                <span
                  style={{
                    width: 52,
                    fontWeight: 700,
                    flexShrink: 0,
                    textTransform: "uppercase",
                    color:
                      entry.level === "error"
                        ? "var(--danger)"
                        : entry.level === "warn"
                          ? "var(--warning)"
                          : "var(--text-secondary)",
                  }}
                >
                  {entry.level}
                </span>
                <span style={{ width: 90, color: "var(--accent)", flexShrink: 0 }}>
                  {entry.category}
                </span>
                <span style={{ flex: 1 }}>{entry.message}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </ScreenShell>
  );
}
