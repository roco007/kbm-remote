/**
 * Theme store (Zustand) — M3 light/dark/system selection.
 *
 * Mode is persisted to AsyncStorage so the user's choice survives restarts.
 * `tokens` is a derived getter (select the flat object, not a nested one)
 * which re-computes per-access from the current mode + system color scheme
 * — acceptable because RN re-renders on store change, and `useColors()`
 * selectors return stable references.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useColorScheme, type ColorSchemeName } from "react-native";
import { create } from "zustand";

import { darkM3, lightM3, type M3Tokens, type ThemeMode } from "../theme";

export interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  /** Derived: the token set to render with (no new objects created here —
   *  the two theme constants are frozen singletons). */
  tokens: M3Tokens;
}

const STORAGE_KEY = "kbm.theme.mode.v1";

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: "system",
  setMode: async (mode) => {
    set({ mode });
    try {
      await AsyncStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* persistence is best-effort */
    }
  },
  get tokens(): M3Tokens {
    const { mode } = get();
    return mode === "dark" ? darkM3 : mode === "light" ? lightM3 : (undefined as never);
  },
}));

/**
 * React hook that applies the system override: in "system" mode the caller
 * should use `useResolvedTokens()` instead of reading `useThemeStore(s=>s.tokens)`.
 */
export function useResolvedTokens(): M3Tokens {
  const mode = useThemeStore((s) => s.mode);
  const scheme: ColorSchemeName = useColorScheme();
  if (mode === "system") {
    return scheme === "dark" ? darkM3 : lightM3;
  }
  return mode === "dark" ? darkM3 : lightM3;
}

/** Hydrate the persisted mode before first render (call once at app boot). */
export async function hydrateTheme(): Promise<void> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      useThemeStore.setState({ mode: stored });
    }
  } catch {
    /* cold start without storage is fine */
  }
}
