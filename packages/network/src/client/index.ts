/**
 * WSS client barrel — connection lifecycle, auth handshake, heartbeat,
 * exponential-backoff reconnection (Protocol Spec §5.4, §6.3).
 */

export {
  ClientConnection,
  type ClientEvents,
  type ClientOptions,
  type ClientSocket,
  type ClientState,
  type FrameResult,
  type PendingFrame,
} from "./ClientConnection";
export { FrameCoalescer } from "./FrameCoalescer";
