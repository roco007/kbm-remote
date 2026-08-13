/**
 * Material Design 3 token set for the receiver dashboard (light + dark).
 *
 * Extends the shared `@kbm-remote/ui-components` tokens (base color roles and
 * radii) with the elevation surfaces, state overlays and motion values the
 * dashboard screens consume. Layouts are identical across modes — dark mode
 * is a pure token swap (UX Design Document §3.1).
 */
import {
  darkTheme,
  lightTheme,
  motion,
  type ThemeTokens,
} from "@kbm-remote/ui-components";

export type ThemeMode = "system" | "light" | "dark";

export interface M3Tokens extends ThemeTokens {
  /** Elevated surface layers (cards sit on bgApp). */
  bgElevated: string;
  /** Chip / hover state overlay on surfaces. */
  onSurfaceVariant: string;
  /** Outline colour for fields and cards. */
  outline: string;
  /** Focus ring colour. */
  focusRing: string;
  /** Disabled control opacity. */
  disabledAlpha: number;
  motion: typeof motion;
}

export const lightM3: M3Tokens = {
  ...lightTheme,
  bgElevated: "#FFFFFF",
  onSurfaceVariant: "rgba(17, 20, 25, 0.06)",
  outline: "#DDE1E7",
  focusRing: "#4F6EF7",
  disabledAlpha: 0.38,
  motion,
};

export const darkM3: M3Tokens = {
  ...darkTheme,
  bgElevated: "#1E222B",
  onSurfaceVariant: "rgba(232, 235, 241, 0.08)",
  outline: "#2A2F3A",
  focusRing: "#6B84F9",
  disabledAlpha: 0.38,
  motion,
};

export const M3_MOTION = {
  microMs: 200,
  sheetMs: 300,
  easing: "ease-out",
} as const;
