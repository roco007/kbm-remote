/**
 * Shared transport constants — Protocol Spec §3.5, §5.2, §5.4, §6.3.
 *
 * Single source of truth for timeout and retry values used by both the
 * WssGateway (receiver) and the ClientConnection (sender), so the two sides
 * can never drift apart on the wire contract.
 */

/** Advertised WebSocket subprotocol. */
export const SUBPROTOCOL = "kbmremote.v1+msgpack";

/** Protocol major version carried in every envelope. */
export const PROTOCOL_MAJOR_VERSION = 1;

/** Subprotocol strings a server will accept during the upgrade. */
export const ACCEPTED_SUBPROTOCOLS = [SUBPROTOCOL];

// ── Timeouts (Spec §3.5) ──────────────────────────────────────────────────

/** Window to complete authentication after `Hello`, else close 4001. */
export const AUTH_WINDOW_MS = 30_000;

/** Ping interval — sender-driven (receiver simply replies). */
export const PING_INTERVAL_MS = 5_000;

/**
 * Adaptive heartbeat (Milestone 6, §B.2): when no outbound input frame has
 * been sent for `IDLE_DETECTION_AFTER_MS`, the sender escalates the ping
 * interval by `IDLE_HEARTBEAT_INTERVAL_MS` per successful round trip until
 * `MAX_IDLE_HEARTBEAT_INTERVAL_MS`. Any outbound `send()` instantly restores
 * the fast interval. This cuts radio tail-state wake-ups on battery-powered
 * senders while the user is idle.
 */
export const IDLE_DETECTION_AFTER_MS = 20_000;
export const IDLE_HEARTBEAT_INTERVAL_MS = 15_000;
export const MAX_IDLE_HEARTBEAT_INTERVAL_MS = 60_000;

/** Silence before the watchdog treats the connection as dead. */
export const SILENCE_WATCHDOG_MS = 15_000;

/**
 * Maximum time a new connection may remain unauthenticated before the
 * gateway closes it (security audit §3.2). Prevents cheap anonymous sockets
 * from being parked indefinitely with Ping keep-alives.
 */
export const AUTH_TIMEOUT_MS = 30_000;

/**
 * Per-IP concurrent connection cap (security audit §3.3). Beyond this, new
 * connections from the same address are refused with a fatal close.
 */
export const MAX_CONNECTIONS_PER_IP = 32;

/** Auth-failure ban window in milliseconds (security audit §3.3). */
export const IP_AUTH_BAN_MS = 10 * 60 * 1000;

/** Sliding window of auth failures before the IP is banned. */
export const IP_AUTH_FAILURE_WINDOW_MS = 60_000;

/** Consecutive auth failures inside the window before the IP is banned. */
export const IP_AUTH_BAN_THRESHOLD = 10;

/** Pong must arrive within this many missed-ping intervals before reconnect. */
export const MAX_MISSED_PONGS = 3;

/** Max wait for a `Disconnect` echo before closing 1000. */
export const DISCONNECT_ECHO_WAIT_MS = 2_000;

/** Max age of a Ping/Pong `seq` we will honour (skew protection). */
export const MAX_PING_SEQ_AGE = 8;

// ── Retries (Spec §5.2) ───────────────────────────────────────────────────

/** Max attempts before an acknowledged frame fails to the UX layer. */
export const MAX_ACK_ATTEMPTS = 4;

/** Retry backoff: min(2^i × 250 ms, 3 s) + random(0..250 ms), i = 0..3. */
export const RETRY_BASE_MS = 250;
export const RETRY_CEILING_MS = 3_000;
export const RETRY_JITTER_MS = 250;

export function retryDelay(attempt: number): number {
  const clamped = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CEILING_MS);
  return clamped + Math.random() * RETRY_JITTER_MS;
}

// ── Reconnection (Spec §5.4) ──────────────────────────────────────────────

/** Initial reconnect backoff in milliseconds. */
export const RECONNECT_INITIAL_MS = 500;

/** Hard cap on the reconnect backoff in milliseconds. */
export const RECONNECT_MAX_MS = 10_000;

/**
 * Exponential backoff with full jitter for reconnect attempts:
 * uniform random in [0, min(initial × 2^attempt, max)].
 */
export function reconnectDelay(attempt: number): number {
  const ceiling = Math.min(RECONNECT_INITIAL_MS * 2 ** attempt, RECONNECT_MAX_MS);
  return Math.random() * ceiling;
}

// ── Close codes (Spec §6.3) ───────────────────────────────────────────────

export const CLOSE_CODES = {
  /** Normal; `Disconnect` frame preceded. */
  Normal: 1000,
  /** Not authenticated / auth window expired. */
  NotAuthenticated: 4001,
  /** Unsupported subprotocol/version (non-negotiable). */
  UnsupportedVersion: 4002,
  /** Session revoked. */
  Revoked: 4003,
  /** Incompatible major version. */
  IncompatibleVersion: 4004,
  /** Rate limited (pairing attempts). */
  RateLimited: 4005,
  /** Server shutting down (graceful drain). */
  ServerShutdown: 4006,
} as const;

// ── Nack reasons (Spec §6.1) ──────────────────────────────────────────────

export const NACK_REASONS = [
  "malformed",
  "notAuthenticated",
  "permissionDenied",
  "payloadTooLarge",
  "unknownType",
  "replay",
  "tooManyConnections",
] as const;
export type NackReason = (typeof NACK_REASONS)[number];

export function isNackReason(value: string): value is NackReason {
  return (NACK_REASONS as readonly string[]).includes(value);
}
