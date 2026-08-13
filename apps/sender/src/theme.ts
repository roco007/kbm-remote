/**
 * Material Design 3 theme tokens for the KBM Remote sender.
 *
 * The palette follows the M3 tonal system: a primary purple seed (the same
 * accent family as `@kbm-remote/ui-components` so receiver and sender feel
 * like one product), with per-elevation surface tints in dark mode and
 * dedicated on-* contrast values. Every screen consumes these values —
 * never raw hex literals.
 *
 * Dark mode is a full token swap over identical layouts; the theme store
 * (Zustand, persisted) selects light/dark/system.
 */
import { lightTheme, darkTheme } from "@kbm-remote/ui-components";

// darkTheme values are consumed inline in the `darkM3` palette below.

export type ThemeMode = "light" | "dark" | "system";

/**
 * The sender's M3 token set. Field names mirror M3 roles and deliberately
 * avoid colliding with `ThemeTokens` (bgApp/textPrimary/…) — the ui layer
 * keeps its own vocabulary, the sender layer keeps M3's.
 */
export interface M3Tokens {
  /** App background (ThemeTokens.bgApp equivalent). */
  bgApp: string;
  /** Elevated card/surface background (ThemeTokens.bgSurface equivalent). */
  bgSurface: string;
  /** Primary text (ThemeTokens.textPrimary equivalent). */
  textPrimary: string;
  /** Secondary text (ThemeTokens.textSecondary equivalent). */
  textSecondary: string;
  /** Accent (ThemeTokens.accent equivalent). */
  accent: string;
  /** M3 role: content rendered on the primary accent. */
  onPrimary: string;
  /** M3 role: content rendered on surfaces. */
  onSurface: string;
  /** M3 role: secondary content on surfaces. */
  onSurfaceVariant: string;
  /** M3 elevation 1 container. */
  surfaceContainer: string;
  /** M3 elevation 2 container (buttons/chips). */
  surfaceContainerHigh: string;
  /** M3 outline (active controls). */
  outline: string;
  /** M3 outline variant (passive dividers). */
  outlineVariant: string;
  /** Semantic tokens (ThemeTokens.success/warning/danger equivalents). */
  success: string;
  warning: string;
  danger: string;
  /** Secondary action color. */
  secondary: string;
  onSecondary: string;
  /** Dialog/backdrop scrim. */
  scrim: string;
}

export const lightM3: M3Tokens = {
  bgApp: lightTheme.bgApp,
  bgSurface: lightTheme.bgSurface,
  textPrimary: lightTheme.textPrimary,
  textSecondary: lightTheme.textSecondary,
  accent: lightTheme.accent,
  success: lightTheme.success,
  warning: lightTheme.warning,
  danger: lightTheme.danger,
  onSurface: "#1C1B1F",
  onSurfaceVariant: "#49454F",
  onPrimary: "#FFFFFF",
  surfaceContainer: "#F4EFF7",
  surfaceContainerHigh: "#ECE6F0",
  outline: "#79747E",
  outlineVariant: "#CAC4D0",
  secondary: "#625B71",
  onSecondary: "#FFFFFF",
  scrim: "rgba(0,0,0,0.32)",
};

export const darkM3: M3Tokens = {
  bgApp: darkTheme.bgApp,
  bgSurface: "#1D1B20",
  textPrimary: darkTheme.textPrimary,
  textSecondary: "#CAC4D0",
  accent: "#D0BCFF",
  success: darkTheme.success,
  warning: darkTheme.warning,
  danger: darkTheme.danger,
  onSurface: "#E6E1E5",
  onSurfaceVariant: "#CAC4D0",
  onPrimary: "#381E72",
  surfaceContainer: "#211F26",
  surfaceContainerHigh: "#2B2930",
  outline: "#938F99",
  outlineVariant: "#49454F",
  secondary: "#CCC2DC",
  onSecondary: "#332D41",
  scrim: "rgba(0,0,0,0.52)",
};

/** Motion spec — M3 standard durations. Respect reduced-motion at call sites. */
export const m3Motion = {
  /** Press feedback (scale/opacity). */
  pressMs: 80,
  /** Micro interactions: chips, toggles, ripples. */
  microMs: 180,
  /** Screen-level fades and surface transitions. */
  transitionMs: 280,
  /** Keyboard layout switch / slide advance. */
  layoutMs: 220,
} as const;
