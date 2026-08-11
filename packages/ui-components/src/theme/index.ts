/**
 * Design tokens shared by the receiver (Electron/React) and sender
 * (React Native) — see UX Design Document §3.1.
 *
 * Dark mode is a token swap over identical layouts; every screen consumes
 * these values, never raw hex literals.
 */

export interface ThemeTokens {
  bgApp: string;
  bgSurface: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  border: string;
  radiusMd: number;
  radiusLg: number;
}

export const lightTheme: ThemeTokens = {
  bgApp: "#F7F8FA",
  bgSurface: "#FFFFFF",
  textPrimary: "#111419",
  textSecondary: "#6B7280",
  accent: "#4F6EF7",
  success: "#16A34A",
  warning: "#D97706",
  danger: "#DC2626",
  border: "#E5E7EB",
  radiusMd: 12,
  radiusLg: 16,
};

export const darkTheme: ThemeTokens = {
  bgApp: "#0F1115",
  bgSurface: "#181B22",
  textPrimary: "#E8EBF1",
  textSecondary: "#9AA3B2",
  accent: "#6B84F9",
  success: "#22C55E",
  warning: "#F59E0B",
  danger: "#EF4444",
  border: "#2A2F3A",
  radiusMd: 12,
  radiusLg: 16,
};

/** Motion spec — UX Design Document §3.1 (respect reduced-motion at call sites). */
export const motion = {
  microMs: 200,
  sheetMs: 300,
  easing: "ease-out",
} as const;
