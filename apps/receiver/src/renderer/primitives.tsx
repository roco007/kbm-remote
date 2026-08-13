/**
 * M3 UI primitives — the shared widget set for the receiver dashboard.
 *
 * Every widget reads the current M3 token set through `useTokens()`; screens
 * never touch raw colours. Components accept a `className`-free `style`
 * contract (plain inline styles) so the bundle stays dependency-free beyond
 * React: no CSS-in-JS runtime, no Tailwind in the Electron build.
 */
import {
  createContext,
  useContext,
  useMemo,
  type CSSProperties,
  type ReactNode,
} from "react";

import { darkM3, lightM3, type M3Tokens, type ThemeMode } from "./theme";

// ── Token context ─────────────────────────────────────────────────────────

const TokenContext = createContext<M3Tokens>(lightM3);

export function TokenProvider({
  mode,
  children,
}: {
  mode: ThemeMode;
  children: ReactNode;
}) {
  const tokens = mode === "dark" ? darkM3 : lightM3;
  return <TokenContext.Provider value={tokens}>{children}</TokenContext.Provider>;
}

export function useTokens(): M3Tokens {
  return useContext(TokenContext);
}

function t(toks: M3Tokens): Record<string, string> {
  return {
    "--bg-app": toks.bgApp,
    "--bg-surface": toks.bgSurface,
    "--bg-elevated": toks.bgElevated,
    "--text-primary": toks.textPrimary,
    "--text-secondary": toks.textSecondary,
    "--accent": toks.accent,
    "--success": toks.success,
    "--warning": toks.warning,
    "--danger": toks.danger,
    "--border": toks.border,
    "--outline": toks.outline,
    "--focus-ring": toks.focusRing,
  } as Record<string, string>;
}

export function baseAppStyle(): CSSProperties {
  return {
    ...t(useTokens()),
    background: "var(--bg-app)",
    color: "var(--text-primary)",
    fontFamily: "'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, 'Noto Sans', sans-serif",
    minHeight: "100vh",
  };
}

// ── Layout primitives ─────────────────────────────────────────────────────

export function Card({
  title,
  children,
  actions,
  style,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  style?: CSSProperties;
}) {
  const toks = useTokens();
  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: `1px solid var(--border)`,
        borderRadius: toks.radiusLg,
        padding: 16,
        ...style,
      }}
    >
      {(title || actions) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          {title ? (
            <h3
              style={{
                margin: 0,
                fontSize: 14,
                fontWeight: 600,
                letterSpacing: "0.02em",
              }}
            >
              {title}
            </h3>
          ) : (
            <div />
          )}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

export function ScreenShell({
  title,
  subtitle,
  children,
  actions,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div style={{ padding: "24px 28px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>{title}</h2>
          {subtitle ? (
            <p
              style={{ margin: "4px 0 0", color: "var(--text-secondary)", fontSize: 13 }}
            >
              {subtitle}
            </p>
          ) : null}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

// ── Interactive primitives ────────────────────────────────────────────────

const BUTTON_BASE: CSSProperties = {
  border: "none",
  borderRadius: 20,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 13,
  letterSpacing: "0.03em",
  transition:
    "background-color 200ms ease-out, transform 120ms ease-out, opacity 120ms ease-out",
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
};

export function M3Button({
  variant = "filled",
  children,
  onClick,
  disabled,
  style,
  title,
}: {
  variant?: "filled" | "outlined" | "text" | "danger";
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  style?: CSSProperties;
  title?: string;
}) {
  const toks = useTokens();
  const styles: Record<string, CSSProperties> = useMemo(
    () => ({
      filled: {
        ...BUTTON_BASE,
        background: "var(--accent)",
        color: "#FFFFFF",
        padding: "10px 22px",
      },
      outlined: {
        ...BUTTON_BASE,
        background: "transparent",
        color: "var(--accent)",
        border: `1px solid var(--accent)`,
        padding: "9px 21px",
      },
      text: {
        ...BUTTON_BASE,
        background: "transparent",
        color: "var(--accent)",
        padding: "10px 12px",
      },
      danger: {
        ...BUTTON_BASE,
        background: "var(--danger)",
        color: "#FFFFFF",
        padding: "10px 22px",
      },
    }),
    [],
  );

  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.96)")}
      onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
      onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
      style={{ ...styles[variant], opacity: disabled ? toks.disabledAlpha : 1, ...style }}
    >
      {children}
    </button>
  );
}

export function M3IconButton({
  children,
  onClick,
  tone = "default",
  title,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "default" | "danger" | "success";
  title?: string;
  disabled?: boolean;
}) {
  const toks = useTokens();
  const color =
    tone === "danger"
      ? "var(--danger)"
      : tone === "success"
        ? "var(--success)"
        : "var(--text-secondary)";
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        borderRadius: "50%",
        width: 36,
        height: 36,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? toks.disabledAlpha : 1,
        transition: "background-color 150ms ease-out",
        fontSize: 18,
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = "var(--on-surface-variant, rgba(0,0,0,0.05))")
      }
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {children}
    </button>
  );
}

export function M3Chip({
  label,
  tone = "default",
  active,
  onClick,
}: {
  label: string;
  tone?: "default" | "success" | "warning" | "danger" | "accent";
  active?: boolean;
  onClick?: () => void;
}) {
  const color =
    tone === "success"
      ? "var(--success)"
      : tone === "warning"
        ? "var(--warning)"
        : tone === "danger"
          ? "var(--danger)"
          : tone === "accent"
            ? "var(--accent)"
            : "var(--text-secondary)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        fontWeight: 600,
        color,
        background: active ? color : "transparent",
        border: `1px solid ${color}`,
        borderRadius: 14,
        padding: "3px 10px",
        ...(active ? { color: "#FFFFFF" } : {}),
      }}
      onClick={onClick}
    >
      {label}
    </span>
  );
}

export function M3Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const toks = useTokens();
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        position: "relative",
        width: 44,
        height: 24,
        borderRadius: 12,
        border: "none",
        cursor: disabled ? "default" : "pointer",
        background: checked ? "var(--accent)" : "var(--text-secondary)",
        opacity: disabled ? toks.disabledAlpha : 1,
        transition: "background-color 200ms ease-out",
        padding: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: checked ? 23 : 3,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "#FFFFFF",
          transition: `left ${toks.motion.microMs}ms ${toks.motion.easing}`,
          boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
        }}
      />
    </button>
  );
}

export function M3Field({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  type = "text",
  style,
}: {
  label?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
  type?: string;
  style?: CSSProperties;
}) {
  const toks = useTokens();
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}>
      {label && (
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
          {label}
        </span>
      )}
      <input
        type={type}
        disabled={disabled}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: "var(--bg-app)",
          border: `1px solid var(--outline)`,
          borderRadius: toks.radiusMd,
          color: "var(--text-primary)",
          padding: "10px 14px",
          fontSize: 13,
          outline: "none",
          transition: "border-color 150ms ease-out, box-shadow 150ms ease-out",
          opacity: disabled ? toks.disabledAlpha : 1,
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "var(--focus-ring)";
          e.currentTarget.style.boxShadow =
            "0 0 0 2px color-mix(in srgb, var(--focus-ring) 25%, transparent)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "var(--outline)";
          e.currentTarget.style.boxShadow = "none";
        }}
      />
    </label>
  );
}

export function M3Select({
  label,
  value,
  onChange,
  options,
  style,
}: {
  label?: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
  style?: CSSProperties;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}>
      {label && (
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
          {label}
        </span>
      )}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: "var(--bg-app)",
          border: "1px solid var(--outline)",
          borderRadius: 12,
          color: "var(--text-primary)",
          padding: "10px 14px",
          fontSize: 13,
          outline: "none",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Modal({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const toks = useTokens();
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        animation: `fadeIn ${toks.motion.sheetMs}ms ${toks.motion.easing}`,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: toks.radiusLg,
          padding: 24,
          minWidth: 360,
          maxWidth: "80vw",
          boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
          animation: `scaleIn ${toks.motion.sheetMs}ms ${toks.motion.easing}`,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h3>
          <M3IconButton onClick={onClose} title="Close">
            ✕
          </M3IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        borderBottom: "1px solid var(--border)",
        marginBottom: 20,
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          style={{
            background: "transparent",
            border: "none",
            borderBottom:
              active === tab.id ? "2px solid var(--accent)" : "2px solid transparent",
            color: active === tab.id ? "var(--accent)" : "var(--text-secondary)",
            fontWeight: active === tab.id ? 600 : 500,
            fontSize: 13,
            padding: "10px 16px",
            cursor: "pointer",
            transition: "color 150ms ease-out, border-color 150ms ease-out",
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Sidebar({
  items,
  active,
  onChange,
  footer,
}: {
  items: { id: string; label: string; icon: ReactNode; badge?: number }[];
  active: string;
  onChange: (id: string) => void;
  footer?: ReactNode;
}) {
  return (
    <nav
      style={{
        width: 220,
        flexShrink: 0,
        background: "var(--bg-surface)",
        borderRight: `1px solid var(--border)`,
        display: "flex",
        flexDirection: "column",
        padding: "16px 8px",
        gap: 4,
      }}
    >
      <div
        style={{
          padding: "4px 16px 16px",
          borderBottom: `1px solid var(--border)`,
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.02em" }}>
          KBM Remote
        </div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
          Receiver Dashboard
        </div>
      </div>
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            onClick={() => onChange(item.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              background: isActive ? "var(--on-surface-variant)" : "transparent",
              border: "none",
              borderRadius: 24,
              color: isActive ? "var(--accent)" : "var(--text-primary)",
              fontWeight: isActive ? 600 : 500,
              fontSize: 13,
              padding: "11px 16px",
              cursor: "pointer",
              textAlign: "left",
              width: "100%",
              transition: "background-color 150ms ease-out, color 150ms ease-out",
            }}
          >
            <span
              style={{
                fontSize: 16,
                width: 20,
                textAlign: "center",
                display: "inline-block",
              }}
            >
              {item.icon}
            </span>
            <span style={{ flex: 1 }}>{item.label}</span>
            {item.badge ? (
              <span
                style={{
                  background: "var(--accent)",
                  color: "#FFFFFF",
                  fontSize: 11,
                  fontWeight: 700,
                  borderRadius: 10,
                  padding: "1px 8px",
                  minWidth: 20,
                  textAlign: "center",
                }}
              >
                {item.badge}
              </span>
            ) : null}
          </button>
        );
      })}
      {footer ? (
        <div style={{ marginTop: "auto", paddingTop: 12 }}>{footer}</div>
      ) : (
        <div style={{ marginTop: "auto" }} />
      )}
      <div
        style={{ fontSize: 11, color: "var(--text-secondary)", padding: "12px 16px 0" }}
      >
        KBM Remote v0.1.0
      </div>
    </nav>
  );
}

export function EmptyState({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div
      style={{
        textAlign: "center",
        padding: "44px 20px",
        color: "var(--text-secondary)",
      }}
    >
      <div style={{ fontSize: 34, marginBottom: 10, opacity: 0.7 }}>{icon}</div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: "var(--text-primary)",
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      {description ? <div style={{ fontSize: 12.5 }}>{description}</div> : null}
    </div>
  );
}
