/**
 * Settings — theme mode (light/dark/system), pointer sensitivity, scroll
 * speed, haptics, and keep-awake. Each control writes through its Zustand
 * store which persists to AsyncStorage.
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { M3Card, tapHaptic } from "../components/primitives";
import { HubHeader } from "../navigation/HubHeader";
import { useSettingsStore } from "../store/settingsStore";
import { useResolvedTokens, useThemeStore } from "../store/themeStore";

import type { ThemeMode } from "../theme";

const MODES: { mode: ThemeMode; label: string }[] = [
  { mode: "system", label: "System" },
  { mode: "light", label: "Light" },
  { mode: "dark", label: "Dark" },
];

export default function SettingsScreen() {
  const t = useResolvedTokens();
  const insets = useSafeAreaInsets();
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  // Settings controls (scalar, stable selectors).
  const sensitivity = useSettingsStore((s) => s.pointerSensitivity);
  const scrollSpeed = useSettingsStore((s) => s.scrollSpeed);
  const haptics = useSettingsStore((s) => s.haptics);
  const setSensitivity = useSettingsStore((s) => s.setSensitivity);
  const setScrollSpeed = useSettingsStore((s) => s.setScrollSpeed);
  const setHaptics = useSettingsStore((s) => s.setHaptics);

  return (
    <View style={{ flex: 1, backgroundColor: t.bgApp }}>
      <HubHeader title="Settings" />
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}
      >
        <M3Card style={styles.card}>
          <Text style={[styles.subheading, { color: t.textPrimary }]}>Appearance</Text>
          <View style={styles.modeRow}>
            {MODES.map(({ mode: m, label }) => (
              <Pressable
                key={m}
                onPress={() => {
                  tapHaptic();
                  void setMode(m);
                }}
                style={({ pressed }) => [
                  styles.modeChip,
                  {
                    backgroundColor: mode === m ? t.accent : t.surfaceContainerHigh,
                    borderColor: t.outline,
                  },
                  pressed && { opacity: 0.7 },
                ]}
                accessibilityRole="button"
                accessibilityLabel={`${label} theme`}
              >
                <Text
                  style={[
                    styles.modeChipText,
                    { color: mode === m ? t.onPrimary : t.onSurface },
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        </M3Card>

        <M3Card style={styles.card}>
          <Text style={[styles.subheading, { color: t.textPrimary }]}>Touchpad</Text>

          <Text style={[styles.label, { color: t.textSecondary }]}>
            Pointer sensitivity — {sensitivity.toFixed(1)}
          </Text>
          <View style={styles.stepperRow}>
            <Stepper
              value={sensitivity}
              min={0.5}
              max={3}
              step={0.1}
              format={(v) => v.toFixed(1)}
              onChange={(v) => void setSensitivity(v)}
            />
          </View>

          <Text style={[styles.label, { color: t.textSecondary }]}>
            Scroll speed — {scrollSpeed}
          </Text>
          <View style={styles.stepperRow}>
            <Stepper
              value={scrollSpeed}
              min={1}
              max={5}
              step={1}
              format={(v) => String(Math.round(v))}
              onChange={(v) => void setScrollSpeed(v)}
            />
          </View>
        </M3Card>

        <M3Card style={styles.card}>
          <Text style={[styles.subheading, { color: t.textPrimary }]}>Feedback</Text>
          <Pressable
            onPress={() => {
              tapHaptic();
              void setHaptics(!haptics);
            }}
            style={({ pressed }) => [styles.switchRow, pressed && { opacity: 0.7 }]}
            accessibilityRole="switch"
            accessibilityState={{ checked: haptics }}
            accessibilityLabel="Haptic feedback on key presses"
          >
            <Text style={[styles.switchLabel, { color: t.textPrimary }]}>
              Haptic feedback
            </Text>
            <View
              style={[
                styles.switchTrack,
                { backgroundColor: haptics ? t.accent : t.outlineVariant },
              ]}
            >
              <View
                style={[
                  styles.switchThumb,
                  {
                    backgroundColor: t.onPrimary,
                    transform: [{ translateX: haptics ? 20 : 0 }],
                  },
                ]}
              />
            </View>
          </Pressable>
        </M3Card>

        <Text style={[styles.note, { color: t.textSecondary }]}>
          Settings are stored on this device only. The receiver applies its own permission
          policy — controls that are not permitted by the receiver session are disabled
          automatically.
        </Text>
      </ScrollView>
    </View>
  );
}

function Stepper(props: {
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const t = useResolvedTokens();
  const { value, min, max, step, format, onChange } = props;
  return (
    <View style={styles.stepper}>
      <Pressable
        onPress={() => {
          tapHaptic();
          onChange(Math.max(min, value - step));
        }}
        disabled={value <= min}
        style={({ pressed }) => [
          styles.stepperButton,
          { borderColor: t.outline },
          pressed && { opacity: 0.6 },
        ]}
        accessibilityRole="button"
        accessibilityLabel="Decrease"
      >
        <Text style={[styles.stepperGlyph, { color: t.onSurface }]}>−</Text>
      </Pressable>
      <View style={[styles.stepperValue, { borderColor: t.outline }]}>
        <Text style={[styles.stepperValueText, { color: t.onSurface }]}>
          {format(value)}
        </Text>
      </View>
      <Pressable
        onPress={() => {
          tapHaptic();
          onChange(Math.min(max, value + step));
        }}
        disabled={value >= max}
        style={({ pressed }) => [
          styles.stepperButton,
          { borderColor: t.outline },
          pressed && { opacity: 0.6 },
        ]}
        accessibilityRole="button"
        accessibilityLabel="Increase"
      >
        <Text style={[styles.stepperGlyph, { color: t.onSurface }]}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    padding: 16,
    gap: 16,
  },
  card: { gap: 14 },
  subheading: { fontSize: 16, fontWeight: "600", lineHeight: 21 },
  modeRow: { flexDirection: "row", gap: 10 },
  modeChip: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 10,
  },
  modeChipText: { fontSize: 14, fontWeight: "600", lineHeight: 18 },
  label: { fontSize: 13, lineHeight: 18, fontWeight: "500" },
  stepperRow: { marginTop: -6 },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  stepperButton: {
    borderWidth: 1,
    borderRadius: 999,
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperGlyph: { fontSize: 20, lineHeight: 24, fontWeight: "400" },
  stepperValue: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    height: 40,
  },
  stepperValueText: { fontSize: 16, fontWeight: "600", lineHeight: 20 },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  switchLabel: { fontSize: 15, lineHeight: 20 },
  switchTrack: {
    width: 48,
    height: 28,
    borderRadius: 999,
    justifyContent: "center",
    padding: 4,
  },
  switchThumb: {
    width: 20,
    height: 20,
    borderRadius: 999,
  },
  note: { fontSize: 13, lineHeight: 19, paddingHorizontal: 4 },
});
