/**
 * Clipboard store (Zustand) — sender-side clipboard history and the latest
 * remote clipboard snapshot retrieved via ClipboardQuery (0x71).
 *
 * The history is capped at MAX_HISTORY and older entries fall off the front
 * (newest first). Content larger than MAX_ITEM_BYTES is rejected up front so
 * oversized uploads never reach the network layer.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";

export const MAX_HISTORY = 20;
export const MAX_ITEM_BYTES = 64 * 1024; // mirrors the receiver's text cap

export interface ClipboardEntry {
  text: string;
  /** ISO timestamp when the entry was recorded. */
  at: string;
}

export interface ClipboardState {
  history: ClipboardEntry[];
  /** Last content pulled from the receiver (or sent out), null when unknown. */
  remote: string | null;
  syncing: boolean;

  recordSent: (text: string) => Promise<void>;
  setRemote: (text: string | null) => void;
  setSyncing: (syncing: boolean) => void;
  clear: () => void;
}

const KEY = "kbm.clipboard.v1";

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export const useClipboardStore = create<ClipboardState>((set) => ({
  history: [],
  remote: null,
  syncing: false,

  recordSent: async (text) => {
    if (utf8Bytes(text) > MAX_ITEM_BYTES) {
      return; // oversized — drop before it becomes a history entry
    }
    set((state) => {
      const entry: ClipboardEntry = { text, at: new Date().toISOString() };
      const history = [entry, ...state.history.filter((e) => e.text !== text)].slice(
        0,
        MAX_HISTORY,
      );
      return { history };
    });
    // Persist after the render — the in-memory update is already authoritative.
    try {
      await AsyncStorage.setItem(
        KEY,
        JSON.stringify(useClipboardStore.getState().history),
      );
    } catch {
      /* best-effort */
    }
  },

  setRemote: (remote) => set({ remote }),
  setSyncing: (syncing) => set({ syncing }),
  clear: async () => {
    set({ history: [], remote: null });
    try {
      await AsyncStorage.removeItem(KEY);
    } catch {
      /* best-effort */
    }
  },
}));

/** Hydrate history at boot. */
export async function hydrateClipboard(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as ClipboardEntry[];
    const history = (Array.isArray(parsed) ? parsed : []).filter(
      (e) => e && typeof e.text === "string",
    );
    useClipboardStore.setState({ history: history.slice(0, MAX_HISTORY) });
  } catch {
    /* cold start without storage is fine */
  }
}
