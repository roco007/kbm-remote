/**
 * Hub header — the persistent top bar on the five control screens.
 *
 * Materializes the M3 small top-app-bar: a back chevron, the screen title,
 * and a live connection chip. Tapping the title area returns Home.
 */
import { useNavigation } from "@react-navigation/native";
import { type NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { M3StatusChip, tapHaptic } from "../components/primitives";
import { useConnectionStore } from "../store/connectionStore";
import { useResolvedTokens } from "../store/themeStore";

import type { RootStackParamList } from "./types";

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function HubHeader({ title }: { title: string }) {
  const t = useResolvedTokens();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { state, target, disconnect } = useConnectionStore((s) => ({
    state: s.state,
    target: s.target,
    disconnect: s.disconnect,
  }));

  const connected = state === "connected";
  const chip = connected
    ? { text: target?.name ?? "Connected", tone: "success" as const }
    : { text: "Disconnected", tone: "danger" as const };

  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: t.bgApp, paddingTop: insets.top + 8, paddingBottom: 8 },
      ]}
    >
      <View style={styles.row}>
        <Pressable
          onPress={() => {
            tapHaptic();
            navigation.goBack();
          }}
          style={({ pressed }) => [styles.back, pressed && styles.backPressed]}
          accessibilityRole="button"
          accessibilityLabel="Back to Home"
        >
          <Text style={[styles.backGlyph, { color: t.textPrimary }]}>‹</Text>
        </Pressable>
        <Text style={[styles.title, { color: t.textPrimary }]} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.chipWrap}>
          {connected ? (
            <Pressable
              onPress={() => {
                tapHaptic();
                disconnect();
              }}
              style={({ pressed }) => [styles.chipTouch, pressed && styles.chipPressed]}
              accessibilityRole="button"
              accessibilityLabel="Disconnect from receiver"
            >
              <M3StatusChip text={chip.text} tone={chip.tone} />
            </Pressable>
          ) : (
            <M3StatusChip text={chip.text} tone={chip.tone} />
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    paddingHorizontal: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  back: {
    padding: 8,
  },
  backPressed: {
    opacity: 0.6,
  },
  backGlyph: {
    fontSize: 26,
    lineHeight: 30,
    fontWeight: "300",
  },
  title: {
    flex: 1,
    fontSize: 20,
    fontWeight: "600",
    lineHeight: 26,
  },
  chipWrap: {
    paddingRight: 8,
  },
  chipTouch: {},
  chipPressed: {
    opacity: 0.7,
  },
});
