/**
 * Media Controls (S5) — transport buttons over the receiver's media keys
 * (spec §3.4, MediaKey 0x50): play/pause, prev/next track, volume and mute.
 *
 * Layout follows UX §4 S5: a large central play/pause, prev/next flanking it,
 * and a volume column with +/- and mute. Every button is a single
 * fire-and-forget MediaKey frame — no state is tracked on the sender because
 * the receiver's OS media session is the source of truth.
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { tapHaptic } from "../components/primitives";
import { HubHeader } from "../navigation/HubHeader";
import { mediaKey } from "../services/inputDispatch";
import { useResolvedTokens } from "../store/themeStore";

const GLYPH_PLAY = "▶";
const GLYPH_PREV = "⏮";
const GLYPH_NEXT = "⏭";
const GLYPH_VOL_UP = "＋";
const GLYPH_VOL_DOWN = "－";
const GLYPH_MUTE = "🔇";

export default function MediaControlsScreen() {
  const t = useResolvedTokens();
  const insets = useSafeAreaInsets();

  return (
    <View style={{ flex: 1, backgroundColor: t.bgApp }}>
      <HubHeader title="Media Controls" />
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Transport row: prev / play-pause / next */}
        <View style={styles.transportRow}>
          <MediaGlyph
            glyph={GLYPH_PREV}
            label="Previous track"
            onPress={() => void mediaKey("prevTrack")}
          />
          <MediaGlyph
            glyph={GLYPH_PLAY}
            label="Play/Pause"
            large
            onPress={() => void mediaKey("playPause")}
          />
          <MediaGlyph
            glyph={GLYPH_NEXT}
            label="Next track"
            onPress={() => void mediaKey("nextTrack")}
          />
        </View>

        {/* Volume column */}
        <View style={styles.volCard}>
          <Text style={[styles.volLabel, { color: t.textSecondary }]}>Volume</Text>
          <View style={styles.volRow}>
            <MediaGlyph
              glyph={GLYPH_VOL_DOWN}
              label="Volume down"
              onPress={() => void mediaKey("volumeDown")}
            />
            <MediaGlyph
              glyph={GLYPH_VOL_UP}
              label="Volume up"
              onPress={() => void mediaKey("volumeUp")}
            />
          </View>
          <Pressable
            onPress={() => {
              tapHaptic();
              void mediaKey("mute");
            }}
            style={({ pressed }) => [
              styles.muteButton,
              { borderColor: t.outline },
              pressed && { transform: [{ scale: 0.97 }], opacity: 0.8 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Mute"
          >
            <Text style={[styles.muteGlyph, { color: t.onSurface }]}>{GLYPH_MUTE}</Text>
            <Text style={[styles.muteLabel, { color: t.textSecondary }]}>Mute</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

function MediaGlyph({
  glyph,
  label,
  large,
  onPress,
}: {
  glyph: string;
  label: string;
  large?: boolean;
  onPress: () => void;
}) {
  const t = useResolvedTokens();
  return (
    <Pressable
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => [
        styles.glyphButton,
        large && styles.glyphButtonLarge,
        {
          backgroundColor: t.surfaceContainerHigh,
          borderColor: t.outline,
        },
        pressed && { transform: [{ scale: 0.93 }], opacity: 0.8 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text
        style={[styles.glyphText, large && styles.glyphTextLarge, { color: t.onSurface }]}
      >
        {glyph}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: {
    padding: 16,
    gap: 20,
    alignItems: "center",
  },
  transportRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 20,
    paddingTop: 8,
  },
  glyphButton: {
    width: 72,
    height: 72,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  glyphButtonLarge: {
    width: 96,
    height: 96,
    borderRadius: 28,
    backgroundColor: "#65558F",
    borderColor: "#65558F",
  },
  glyphText: {
    fontSize: 26,
    lineHeight: 30,
  },
  glyphTextLarge: {
    fontSize: 34,
    lineHeight: 38,
    color: "#FFFFFF",
  },
  volCard: {
    width: "100%",
    borderRadius: 20,
    borderWidth: 1,
    padding: 20,
    gap: 14,
    alignItems: "center",
  },
  volLabel: {
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 17,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  volRow: {
    flexDirection: "row",
    gap: 24,
  },
  muteButton: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 12,
  },
  muteGlyph: {
    fontSize: 18,
    lineHeight: 22,
  },
  muteLabel: {
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 18,
  },
});
