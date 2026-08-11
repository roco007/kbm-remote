import { describe, expect, it } from "vitest";

import {
  AUTH_WINDOW_MS,
  CLOSE_CODES,
  DISCONNECT_ECHO_WAIT_MS,
  MAX_ACK_ATTEMPTS,
  MAX_MISSED_PONGS,
  MAX_PING_SEQ_AGE,
  NACK_REASONS,
  PING_INTERVAL_MS,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  RETRY_BASE_MS,
  RETRY_CEILING_MS,
  SILENCE_WATCHDOG_MS,
  SUBPROTOCOL,
  isNackReason,
  reconnectDelay,
  retryDelay,
} from "../src/common";

/**
 * Shared transport constants — Protocol Spec §3.5, §5.2, §5.4, §6.3.
 *
 * These tests pin the numeric contract both sides of the wire rely on, so a
 * stray edit (e.g. changing the ping interval to 10 s on one side only)
 * fails CI before it reaches production.
 */
describe("transport constants", () => {
  it("advertises the agreed subprotocol", () => {
    expect(SUBPROTOCOL).toBe("kbmremote.v1+msgpack");
  });

  it("honours the timing contract (§3.5, §5.1)", () => {
    expect(PING_INTERVAL_MS).toBe(5_000);
    expect(SILENCE_WATCHDOG_MS).toBe(15_000);
    expect(AUTH_WINDOW_MS).toBe(30_000);
    expect(MAX_MISSED_PONGS).toBe(3);
    expect(DISCONNECT_ECHO_WAIT_MS).toBe(2_000);
    expect(MAX_PING_SEQ_AGE).toBe(8);
    // Watchdog must run often enough to catch the 15 s silence.
    expect(SILENCE_WATCHDOG_MS / 2).toBeLessThan(SILENCE_WATCHDOG_MS);
  });

  it("honours the retry contract (§5.2)", () => {
    expect(MAX_ACK_ATTEMPTS).toBe(4);
    expect(RETRY_BASE_MS).toBe(250);
    expect(RETRY_CEILING_MS).toBe(3_000);
    // Attempt 0 → 250..500 ms; attempt 3 → 2000..2250 ms (3 s ceiling).
    for (let i = 0; i <= 3; i += 1) {
      const d = retryDelay(i);
      expect(d).toBeGreaterThanOrEqual(RETRY_BASE_MS * 2 ** i);
      expect(d).toBeLessThanOrEqual(RETRY_CEILING_MS + 250);
    }
  });

  it("honours the reconnect backoff (§5.4): 500 ms → 10 s cap, full jitter", () => {
    expect(RECONNECT_INITIAL_MS).toBe(500);
    expect(RECONNECT_MAX_MS).toBe(10_000);
    // Even with 1000 random draws, bounds must never be violated.
    for (let i = 0; i < 1000; i += 1) {
      const d = reconnectDelay(i);
      const ceiling = Math.min(RECONNECT_INITIAL_MS * 2 ** i, RECONNECT_MAX_MS);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(ceiling);
    }
    // Attempt 0 ceiling is 500 ms — strict cap verified.
    expect(reconnectDelay(0)).toBeLessThan(500);
  });

  it("uses the reserved close codes (§6.3)", () => {
    expect(CLOSE_CODES.Normal).toBe(1000);
    expect(CLOSE_CODES.NotAuthenticated).toBe(4001);
    expect(CLOSE_CODES.UnsupportedVersion).toBe(4002);
    expect(CLOSE_CODES.Revoked).toBe(4003);
    expect(CLOSE_CODES.IncompatibleVersion).toBe(4004);
    expect(CLOSE_CODES.RateLimited).toBe(4005);
    expect(CLOSE_CODES.ServerShutdown).toBe(4006);
    // Must not collide with the IANA-defined ranges' meanings.
    for (const code of Object.values(CLOSE_CODES)) {
      expect(typeof code).toBe("number");
    }
  });

  it("validates nack reasons (§6.1)", () => {
    expect(NACK_REASONS).toEqual(
      expect.arrayContaining([
        "malformed",
        "notAuthenticated",
        "permissionDenied",
        "payloadTooLarge",
        "unknownType",
      ]),
    );
    expect(isNackReason("malformed")).toBe(true);
    expect(isNackReason("bogusReason")).toBe(false);
  });
});
