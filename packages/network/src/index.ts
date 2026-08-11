/**
 * @kbm-remote/network
 *
 * Transport layer shared by both apps:
 *   client/       — WSS client: auth handshake, reconnect, heartbeat, RTT metrics
 *   server/       — WSS gateway host (receiver): auth state machine, rate limits
 *   discovery/    — mDNS/DNS-SD + UDP beacon + manual IP abstractions
 *   monitoring/   — latency histogram, jitter, loss derived from ping/pong
 *
 * Business logic (permissions, device registry) lives in the apps; this
 * package owns only the wire protocol mechanics defined by @kbm-remote/protocol.
 */

// Stubs introduced in M2/M4 milestones; surfaces declared, implementations TODO.
export const NETWORK_PACKAGE_PLACEHOLDER = true;
