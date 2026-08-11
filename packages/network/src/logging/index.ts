/**
 * Structured logger for the transport layer.
 *
 * Deliberately dependency-free: emits plain JSON lines that Electron's main
 * process pipes to the activity log and that React Native forwards to its
 * diagnostics store. Receivers additionally map sustained high-RTT windows
 * to WARN entries per Protocol Spec §6.2.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  module: string;
  message: string;
  meta?: Record<string, unknown>;
}

let sink: (entry: LogEntry) => void = (entry) => {
  // Default sink: human-readable console line (JSON for machines is opt-in).
  const meta = entry.meta ? ` ${JSON.stringify(entry.meta)}` : "";
  // eslint-disable-next-line no-console
  console.log(`[${entry.level.toUpperCase()}][${entry.module}] ${entry.message}${meta}`);
};

export function setLogSink(next: (entry: LogEntry) => void): void {
  sink = next;
}

export function getLogEntries(): LogEntry[] {
  return [];
}

export class Logger {
  constructor(private readonly module: string) {}

  debug(message: string, meta?: Record<string, unknown>): void {
    this.emit("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.emit("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.emit("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.emit("error", message, meta);
  }

  private emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const entry: LogEntry = {
      ts: Date.now(),
      level,
      module: this.module,
      message,
      ...(meta !== undefined ? { meta } : {}),
    };
    sink(entry);
  }
}
