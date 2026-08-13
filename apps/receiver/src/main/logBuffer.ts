/**
 * In-memory application log — ring buffer consumed by the dashboard's Logs
 * screen. The receiver runs unattended, so structured JSON-ish entries are
 * retained in RAM (no disk log files; crashes lose uncommitted entries, which
 * is acceptable for an ephemeral diagnostic view).
 *
 * Entry shape mirrors the receiver logger but adds a category so the UI can
 * filter to network/pairing/auth/device buckets.
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LogBuffer {
  info(category: string, message: string, data?: Record<string, unknown>): void;
  warn(category: string, message: string, data?: Record<string, unknown>): void;
  error(category: string, message: string, data?: Record<string, unknown>): void;
  /** Newest-first slice for the UI tail view. */
  tail(limit: number): LogEntry[];
  all(): LogEntry[];
  clear(): void;
}

export function createLogBuffer(capacity: number): LogBuffer {
  const buffer: LogEntry[] = [];

  function push(
    level: LogLevel,
    category: string,
    message: string,
    data?: Record<string, unknown>,
  ) {
    buffer.push({ ts: Date.now(), level, category, message, data });
    if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
  }

  return {
    info: (category, message, data) => push("info", category, message, data),
    warn: (category, message, data) => push("warn", category, message, data),
    error: (category, message, data) => push("error", category, message, data),
    tail: (limit) => buffer.slice(-Math.max(0, limit)).reverse(),
    all: () => [...buffer],
    clear: () => (buffer.length = 0),
  };
}
