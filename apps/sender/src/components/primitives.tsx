/**
 * Shared M3 primitives — the sender's small, dependency-free component kit.
 *
 * All pressables use Animated-free press feedback (a scale of 0.97 and an
 * opacity dip rendered through the `style` callback — the RN renderer
 * interpolates these without JS-thread cost) plus an optional haptic.
 * Components consume `useResolvedTokens()` so dark mode is a token swap.
 */
import * as Haptics from "expo-haptics";
import { forwardRef } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";

import { useSettingsStore } from "../store/settingsStore";
import { useResolvedTokens } from "../store/themeStore";
import { m3Motion } from "../theme";

/** Fire a light haptic when the setting is enabled (no-op on web). */
export function tapHaptic() {
  if (!useSettingsStore.getState().haptics) return;
  if (Platform.OS !== "web") {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }
}

const pressStyle = (pressed: boolean): ViewStyle => ({
  transform: [{ scale: pressed ? 0.97 : 1 }],
  opacity: pressed ? 0.85 : 1,
});

/** Duration-mapped press feedback — wraps the style callback. */
export function pressCallbackStyle(
  pressed: boolean,
  durationMs = m3Motion.pressMs,
): ViewStyle {
  void durationMs;
  return pressStyle(pressed);
}

interface M3ButtonProps {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "text";
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}

export const M3Button = forwardRef<View, M3ButtonProps>(function M3Button(
  { label, onPress, variant = "secondary", disabled, loading, style },
  ref,
) {
  const t = useResolvedTokens();
  const bg =
    variant === "primary"
      ? t.accent
      : variant === "text"
        ? "transparent"
        : t.surfaceContainerHigh;
  const fg = variant === "primary" ? t.onPrimary : t.onSurface;

  return (
    <Pressable
      ref={ref}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg },
        pressCallbackStyle(pressed),
        disabled && { opacity: 0.45 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <Text style={[styles.buttonLabel, { color: fg }]}>{label}</Text>
      )}
    </Pressable>
  );
});

interface M3CardProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function M3Card({ children, style }: M3CardProps) {
  const t = useResolvedTokens();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: t.surfaceContainer, borderColor: t.outlineVariant },
        style,
      ]}
    >
      {children}
    </View>
  );
}

interface M3StatusChipProps {
  text: string;
  tone?: "success" | "warning" | "danger" | "neutral";
}

export function M3StatusChip({ text, tone = "neutral" }: M3StatusChipProps) {
  const t = useResolvedTokens();
  const color =
    tone === "success"
      ? t.success
      : tone === "warning"
        ? t.warning
        : tone === "danger"
          ? t.danger
          : t.textSecondary;
  return (
    <View style={[styles.chip, { borderColor: color }]}>
      <Text style={[styles.chipText, { color }]}>{text}</Text>
    </View>
  );
}

export interface M3FieldProps extends TextInputProps {
  label?: string;
}

export function M3Field({ label, style, ...props }: M3FieldProps) {
  const t = useResolvedTokens();
  return (
    <View style={styles.fieldWrap}>
      {label ? (
        <Text style={[styles.fieldLabel, { color: t.textSecondary }]}>{label}</Text>
      ) : null}
      <TextInput
        placeholderTextColor={t.textSecondary}
        {...props}
        style={[
          styles.field,
          { color: t.textPrimary, borderColor: t.outline, backgroundColor: t.bgSurface },
          style,
        ]}
      />
    </View>
  );
}

interface M3IconButtonProps {
  onPress: () => void;
  label: string;
  /** Single character or glyph shown inside the button. */
  glyph: string;
  active?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** Square key/transport button used by the keyboard and media screens. */
export function M3IconButton({
  onPress,
  label,
  glyph,
  active,
  style,
}: M3IconButtonProps) {
  const t = useResolvedTokens();
  return (
    <Pressable
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.iconButton,
        {
          backgroundColor: active ? t.accent : t.surfaceContainerHigh,
          borderColor: t.outline,
        },
        pressCallbackStyle(pressed),
        style,
      ]}
    >
      <Text
        style={[styles.iconGlyph, { color: active ? t.onPrimary : t.onSurface }]}
        adjustsFontSizeToFit
      >
        {glyph}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 24,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  buttonLabel: {
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 18,
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
  },
  chip: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipText: {
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 16,
  },
  fieldWrap: {
    marginVertical: 4,
  },
  fieldLabel: {
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 6,
  },
  field: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    minHeight: 48,
    fontSize: 16,
    lineHeight: 20,
  },
  iconButton: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 12,
    minHeight: 52,
    padding: 4,
  },
  iconGlyph: {
    fontSize: 16,
    fontWeight: "600",
    lineHeight: 20,
  },
});
