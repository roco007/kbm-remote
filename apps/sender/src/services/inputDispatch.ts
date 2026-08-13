/**
 * Input dispatch — helpers that turn high-level sender gestures into
 * protocol frames and send them fire-and-forget over the live connection.
 *
 * Fire-and-forget (mid = 0) is the protocol's low-latency path for input
 * (spec §5.2): the sender never blocks on Acks, and the receiver's own
 * throttle + validation absorbs malformed or excess frames.
 */
import { FrameType } from "@kbm-remote/protocol";

import { useConnectionStore } from "../store/connectionStore";

import type { ClientConnection } from "@kbm-remote/network";

function connection(): ClientConnection | null {
  const mgr = useConnectionStore.getState().manager;
  if (!mgr) return null;
  if (mgr.connectionRef.connectionState !== "connected") return null;
  return mgr.connectionRef;
}

export function sendInput(type: number, payload: Record<string, unknown>): boolean {
  const c = connection();
  if (!c) return false;
  // mid/v are injected by ClientConnection.send (fire-and-forget, spec §2.3):
  // mid = 0 marks these as input frames that never block on Acks.
  c.send({ t: type, ts: Date.now(), p: payload });
  return true;
}

// --- Mouse ---------------------------------------------------------------

export function mouseMove(dx: number, dy: number): boolean {
  return sendInput(FrameType.MouseMove, { dx, dy });
}

export function mouseClick(
  button: "left" | "right" | "middle",
  action: "click" | "dblclick" | "down" | "up",
): boolean {
  return sendInput(FrameType.MouseClick, { button, action });
}

export function mouseScroll(axis: "vertical" | "horizontal", amount: number): boolean {
  return sendInput(FrameType.MouseScroll, { axis, amount });
}

export function mouseDragStart(button: "left" | "right" | "middle"): boolean {
  return sendInput(FrameType.MouseDragStart, { button });
}

export function mouseDragMove(x: number, y: number): boolean {
  return sendInput(FrameType.MouseDragMove, { x, y });
}

export function mouseDragEnd(button: "left" | "right" | "middle"): boolean {
  return sendInput(FrameType.MouseDragEnd, { button });
}

// --- Keyboard ------------------------------------------------------------

export function keyPress(keys: string[]): boolean {
  return sendInput(FrameType.KeyPress, { keys });
}

export function keyHold(
  key: string,
  opts?: { repeatStartMs?: number; repeatIntervalMs?: number },
): boolean {
  return sendInput(FrameType.KeyHold, { key, ...opts });
}

export function keyRelease(key: string): boolean {
  return sendInput(FrameType.KeyRelease, { key });
}

export function textInput(text: string): boolean {
  return sendInput(FrameType.TextInput, { text });
}

export function shortcut(keys: string[], holdMs?: number): boolean {
  return sendInput(FrameType.Shortcut, { keys, holdMs });
}

export function mediaKey(
  key: "volumeUp" | "volumeDown" | "mute" | "playPause" | "prevTrack" | "nextTrack",
): boolean {
  return sendInput(FrameType.MediaKey, { key });
}

// --- Clipboard -----------------------------------------------------------

export function clipboardSync(kind: "text" | "image", data: string): boolean {
  return sendInput(FrameType.ClipboardSync, { kind, data });
}

export function clipboardQuery(): boolean {
  return sendInput(FrameType.ClipboardQuery, {});
}

// --- Presentation --------------------------------------------------------

export function presentationSlide(direction: "next" | "prev"): boolean {
  return sendInput(FrameType.PresentationSlide, { direction });
}

/** True while a receiver session is live — used to gate interactive UI. */
export function isConnected(): boolean {
  return connection() !== null;
}
