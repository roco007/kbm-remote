/**
 * Message type registry and payload schemas.
 *
 * Mirrors Protocol Specification §4 — the type ID table is frozen for the
 * v1.x line. Concrete payload interfaces are defined in sibling modules
 * (mouse.ts, keyboard.ts, clipboard.ts, …) and re-exported from this barrel.
 */

/** Numeric discriminator values — Protocol Specification §4.1. */
export const FrameType = {
  Hello: 0x01,
  HelloAck: 0x02,
  Authenticate: 0x03,
  AuthOk: 0x04,
  AuthFailed: 0x05,
  PairRequest: 0x10,
  PairChallenge: 0x11,
  PairResponse: 0x12,
  PairApproved: 0x13,
  PairDenied: 0x14,
  Ping: 0x20,
  Pong: 0x21,
  Ack: 0x30,
  Nack: 0x31,
  MouseMove: 0x40,
  MouseClick: 0x41,
  MouseScroll: 0x42,
  MouseDragStart: 0x43,
  MouseDragMove: 0x44,
  MouseDragEnd: 0x45,
  KeyPress: 0x50,
  KeyHold: 0x51,
  KeyRelease: 0x52,
  TextInput: 0x53,
  Shortcut: 0x54,
  MediaKey: 0x60,
  ClipboardSync: 0x70,
  ClipboardQuery: 0x71,
  FileTransfer: 0x80,
  Command: 0x90,
  CommandResult: 0x91,
  Notification: 0xa0,
  SessionInfo: 0xa1,
  PresentationSlide: 0xb0,
  DisplayQuery: 0xc0,
  DisplayList: 0xc1,
  Disconnect: 0xd0,
  UnsupportedVersion: 0xe0,
} as const;

export type FrameTypeKey = keyof typeof FrameType;

/**
 * Generic frame envelope — Protocol Specification §2.3.
 * `mid === 0` marks fire-and-forget frames (input events, ping/pong).
 * `mid > 0` marks reliable frames requiring an Ack.
 */
export interface FrameEnvelope {
  t: number;
  mid: number;
  v: number;
  ts: number;
  p: Record<string, unknown>;
  c?: 0 | 1; // 1 = compressed payload (Protocol Spec §2.5)
}

/** Every concrete payload is a plain map; specifics live in sibling files. */
export type FramePayload = Record<string, unknown>;
