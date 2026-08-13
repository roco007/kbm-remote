/**
 * Presentation Mode (S8) — full-screen slide control for talks.
 *
 * UX §4 S8: two oversized arrow buttons (next / previous), a session slide
 * counter, and an end-presentation action. `PresentationSlide` frames
 * (0xb0) travel fire-and-forget; the receiver maps them to the active
 * presentation app (PowerPoint/Keynote/Slides via its input subsystem).
 *
 * Keep-awake: activating the screen calls `activateKeepAwake` (expo-keep-awake)
 * so the phone does not dim mid-talk; leaving the screen deactivates it.
 */
import { activateKeepAwake, deactivateKeepAwake } from "expo-keep-awake";
import { useCallback, useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { M3Button, M3Card, tapHaptic } from "../components/primitives";
import { HubHeader } from "../navigation/HubHeader";
import { presentationSlide } from "../services/inputDispatch";
import { usePresentationStore } from "../store/presentationStore";
import { useSettingsStore } from "../store/settingsStore";
import { useResolvedTokens } from "../store/themeStore";

export default function PresentationModeScreen({
  navigation,
}: {
  navigation?: { goBack: () => void };
}) {
  const t = useResolvedTokens();
  const insets = useSafeAreaInsets();
  const { slideIndex, active, goTo, setActive } = usePresentationStore((s) => ({
    slideIndex: s.slideIndex,
    active: s.active,
    goTo: s.goTo,
    setActive: s.setActive,
  }));
  const keepAwakeSetting = useSettingsStore((s) => s.autoLockScreen);

  // Enter presentation mode on mount (screen-level keep-awake, respects the
  // user's "auto-lock screen" setting).
  useEffect(() => {
    setActive(true);
    if (keepAwakeSetting) {
      activateKeepAwake("presentation");
    }
    return () => {
      setActive(false);
      deactivateKeepAwake("presentation");
    };
  }, [setActive, keepAwakeSetting]);

  const slide = useCallback(
    (direction: "next" | "prev") => {
      tapHaptic();
      const ok = presentationSlide(direction);
      if (ok) goTo(direction);
    },
    [goTo],
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.bgApp }}>
      <HubHeader title="Presentation Mode" />
      <View style={[styles.body, { paddingBottom: insets.bottom + 32 }]}>
        <M3Card style={styles.counterCard}>
          <Text style={[styles.counterLabel, { color: t.textSecondary }]}>Slide</Text>
          <Text style={[styles.counterValue, { color: t.textPrimary }]}>
            {slideIndex === 0 ? "—\nstart" : `#${slideIndex}`}
          </Text>
          <Text style={[styles.counterSub, { color: t.textSecondary }]}>
            {active ? "Session live" : "Not active"}
          </Text>
        </M3Card>

        <View style={styles.arrowRow}>
          <SlideArrow glyph="‹" label="Previous slide" onPress={() => slide("prev")} />
          <SlideArrow
            glyph="›"
            label="Next slide"
            onPress={() => slide("next")}
            primary
          />
        </View>

        <Text style={[styles.hint, { color: t.textSecondary }]}>
          Slide commands target whichever presentation app is focused on the receiver.
        </Text>

        <M3Button
          label="Exit presentation mode"
          variant="text"
          onPress={() => navigation?.goBack?.()}
        />
      </View>
    </View>
  );
}

function SlideArrow({
  glyph,
  label,
  onPress,
  primary,
}: {
  glyph: string;
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  const t = useResolvedTokens();
  return (
    <Pressable
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => [
        styles.arrow,
        {
          backgroundColor: primary ? t.accent : t.surfaceContainerHigh,
          borderColor: primary ? t.accent : t.outline,
        },
        pressed && { transform: [{ scale: 0.94 }], opacity: 0.8 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={[styles.arrowGlyph, { color: primary ? t.onPrimary : t.onSurface }]}>
        {glyph}
      </Text>
      <Text
        style={[styles.arrowLabel, { color: primary ? t.onPrimary : t.textSecondary }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    padding: 16,
    gap: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  counterCard: {
    width: "100%",
    alignItems: "center",
    gap: 4,
    paddingVertical: 24,
  },
  counterLabel: {
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 16,
    textTransform: "uppercase",
    letterSpacing: 1.5,
  },
  counterValue: {
    fontSize: 40,
    fontWeight: "700",
    lineHeight: 48,
    textAlign: "center",
  },
  counterSub: {
    fontSize: 13,
    lineHeight: 18,
  },
  arrowRow: {
    flexDirection: "row",
    width: "100%",
    gap: 14,
  },
  arrow: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 28,
    gap: 6,
  },
  arrowGlyph: {
    fontSize: 38,
    lineHeight: 42,
    fontWeight: "300",
  },
  arrowLabel: {
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 16,
  },
  hint: {
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    paddingHorizontal: 12,
  },
});
