/**
 * Settings store (Zustand) — pointer sensitivity, scroll speed, and haptic
 * feedback. Persisted to AsyncStorage; every screen reads the live values.
 *
 * Values are intentionally scalar (no nested objects) so Zustand selectors
 * stay stable and re-renders stay cheap.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";

export interface SenderSettings {
  /** Relative-move gain: screen-pixel fraction per point of finger travel. */
  pointerSensitivity: number; // 0.5 .. 3.0, default 1.2
  /** Scroll ticks emitted per detected scroll gesture step. */
  scrollSpeed: number; // 1 .. 5, default 3
  haptics: boolean; // default true
  autoLockScreen: boolean; // keep the device awake while presenting (default true)
}

const DEFAULTS: SenderSettings = {
  pointerSensitivity: 1.2,
  scrollSpeed: 3,
  haptics: true,
  autoLockScreen: true,
};

const KEY = "kbm.settings.v1";

export interface SettingsState extends SenderSettings {
  setSensitivity: (v: number) => void;
  setScrollSpeed: (v: number) => void;
  setHaptics: (on: boolean) => void;
  setAutoLockScreen: (on: boolean) => void;
  reset: () => void;
}

const clamp = (v: number, min: number, max: number) =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : v;

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULTS,
  setSensitivity: async (v) => {
    const next = { ...get(), pointerSensitivity: clamp(v, 0.5, 3) };
    set({ pointerSensitivity: next.pointerSensitivity });
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  },
  setScrollSpeed: async (v) => {
    const next = { ...get(), scrollSpeed: clamp(v, 1, 5) };
    set({ scrollSpeed: next.scrollSpeed });
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  },
  setHaptics: async (haptics) => {
    set({ haptics });
    await AsyncStorage.setItem(KEY, JSON.stringify({ ...get(), haptics }));
  },
  setAutoLockScreen: async (autoLockScreen) => {
    set({ autoLockScreen });
    await AsyncStorage.setItem(KEY, JSON.stringify({ ...get(), autoLockScreen }));
  },
  reset: async () => {
    set({ ...DEFAULTS });
    await AsyncStorage.setItem(KEY, JSON.stringify(DEFAULTS));
  },
}));

/** Hydrate at app boot, same shape as themeStore. */
export async function hydrateSettings(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<SenderSettings>;
    useSettingsStore.setState({
      ...DEFAULTS,
      ...parsed,
      pointerSensitivity: clamp(parsed.pointerSensitivity ?? 0, 0.5, 3),
      scrollSpeed: clamp(parsed.scrollSpeed ?? 0, 1, 5),
    });
  } catch {
    /* cold start without storage is fine */
  }
}
