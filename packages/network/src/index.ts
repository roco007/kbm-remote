/**
 * @kbm-remote/network
 *
 * Transport layer shared by both apps:
 *   client/       — WSS client: auth handshake, reconnect, heartbeat, RTT metrics
 *   server/       — WSS gateway host (receiver): auth state machine, rate limits
 *   discovery/    — mDNS/DNS-SD + UDP beacon + manual IP abstractions
 *   monitoring/   — latency histogram, jitter, loss derived from ping/pong
 *   transport/    — TLS helpers: cert generation, fingerprinting, pin checks
 *   logging/      — structured transport-layer logging
 *   common/       — shared constants: timeouts, retry policy, close codes
 *
 * Business logic (permissions, device registry) lives in the apps; this
 * package owns only the wire protocol mechanics defined by @kbm-remote/protocol.
 */

export * from "./client";
export * from "./server";
export * from "./monitoring";
export * from "./logging";
export * from "./common";
export * from "./transport/tls";
