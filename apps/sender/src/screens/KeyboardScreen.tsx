/**
 * Keyboard (S4) — a compact QWERTY remote keyboard.
 *
 * Input strategy:
 *   - Printable characters are batched through a hidden TextInput. Every
 *     `onChangeText` flushes accumulated characters as TextInput frames
 *     (spec §3.6, TextInput 0x40) and clears the buffer. Batching beats
 *     per-keystroke KeyPress frames: one round-trip per gesture, full
 *     IME/unicode support, no modifier tracking on the sender.
 *   - Function/special keys use KeyPress frames (Shift+letter and friends
 *     go through the `shortcut` helper which sends the frame with a hold
 *     so the receiver stages the modifier correctly).
 *   - Modifier "lock" toggles (Shift/Caps/Alt/Ctrl) are visual only: they
 *     compose with the next tapped key as a two-element shortcut.
 *
 * Layout follows UX §4 S4: one thumb-friendly grid, a symbol layer toggle,
 * and a function strip (Esc, Tab, Enter, Backspace, Arrows).
 */
import { useCallback, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { M3IconButton, tapHaptic } from "../components/primitives";
import { HubHeader } from "../navigation/HubHeader";
import { keyPress, keyRelease, shortcut, textInput } from "../services/inputDispatch";
import { useResolvedTokens } from "../store/themeStore";

const ROWS: string[][] = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["⇧", "z", "x", "c", "v", "b", "n", "m", "⌫"],
];

const FN_KEYS: { glyph: string; label: string; send: () => void }[] = [
  { glyph: "Esc", label: "Escape", send: () => void shortcut(["Escape"]) },
  { glyph: "Tab", label: "Tab", send: () => void shortcut(["Tab"]) },
  { glyph: "↑", label: "Up arrow", send: () => void shortcut(["ArrowUp"]) },
];

const FN_KEYS_2: { glyph: string; label: string; send: () => void }[] = [
  { glyph: "←", label: "Left arrow", send: () => void shortcut(["ArrowLeft"]) },
  { glyph: "↓", label: "Down arrow", send: () => void shortcut(["ArrowDown"]) },
  { glyph: "→", label: "Right arrow", send: () => void shortcut(["ArrowRight"]) },
];

export default function KeyboardScreen() {
  const t = useResolvedTokens();
  const insets = useSafeAreaInsets();
  const [buffer, setBuffer] = useState("");
  const [shifted, setShifted] = useState(false);
  const [caps, setCaps] = useState(false);
  const inputRef = useRef<TextInput>(null);

  // Flush the batched text as one TextInput frame.
  const flush = useCallback((text: string) => {
    if (!text) return;
    textInput(text);
    setBuffer("");
  }, []);

  const handleTextChange = useCallback(
    (text: string) => {
      setBuffer(text);
      // Auto-flush once a gesture's batch looks complete (≥4 chars) or after a
      // debounce handled by the user lifting their thumb (RN fires onChangeText
      // synchronously per edit; flushing eagerly keeps latency minimal).
      if (text.length >= 4) flush(text);
    },
    [flush],
  );

  const commitAndClear = useCallback(() => {
    if (buffer) flush(buffer);
    inputRef.current?.clear();
  }, [buffer, flush]);

  const display = (k: string) => {
    if (k === "⇧") return shifted ? "⇧" : caps ? "Aa" : "⇧";
    if (k === "⌫") return "⌫";
    return shifted || caps ? k.toUpperCase() : k;
  };

  const handleSpecial = useCallback(
    (k: string) => {
      commitAndClear();
      tapHaptic();
      if (k === "⌫") void shortcut(["Backspace"]);
      else if (k === "⇧") setShifted((s) => !s);
      else if (k === "Aa") {
        setCaps((c) => !c);
        setShifted(false);
      } else if (k === " ") void textInput(" ");
      else if (shifted || caps) {
        // `shortcut` sends modifier+key in one frame (spec §3.5, holdMs covers
        // modifier staging on the receiver) — fire-and-forget.
        void shortcut([shifted ? "Shift" : "CapsLock", k]);
        setShifted(false);
      } else void keyPress([k]);
    },
    [commitAndClear],
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: t.bgApp }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <HubHeader title="Keyboard" />
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Hidden batcher — the user types into it; it never gains focus visually. */}
        <View style={styles.batcherWrap}>
          <TextInput
            ref={inputRef}
            value={buffer}
            onChangeText={handleTextChange}
            style={[styles.batcher, { color: t.textPrimary, borderColor: t.outline }]}
            placeholder="Type here…"
            placeholderTextColor={t.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            blurOnSubmit
          />
          {buffer.length > 0 ? (
            <Pressable
              onPress={commitAndClear}
              style={({ pressed }) => [styles.flushChip, pressed && { opacity: 0.7 }]}
              accessibilityRole="button"
              accessibilityLabel="Send typed text now"
            >
              <Text style={[styles.flushChipText, { color: t.onPrimary }]}>Send</Text>
            </Pressable>
          ) : null}
        </View>

        {/* Function strip — one tap actions. */}
        <View style={styles.fnRow}>
          {FN_KEYS.map((k) => (
            <M3IconButton
              key={k.label}
              glyph={k.glyph}
              label={k.label}
              onPress={k.send}
            />
          ))}
          <View style={styles.fnSpacer} />
          {FN_KEYS_2.map((k) => (
            <M3IconButton
              key={k.label}
              glyph={k.glyph}
              label={k.label}
              onPress={k.send}
            />
          ))}
        </View>

        {/* QWERTY grid. */}
        <View style={styles.grid}>
          {ROWS.map((row, ri) => (
            <View key={ri} style={styles.row}>
              {row.map((k) => {
                const wide = k === "⇧" || k === "⌫";
                const active =
                  (k === "⇧" && shifted) || (k === "⇧" && !shifted && caps && k === "⇧");
                return (
                  <Pressable
                    key={k}
                    onPress={() => handleSpecial(k)}
                    onLongPress={
                      k === " "
                        ? () => {
                            tapHaptic();
                            commitAndClear();
                            void keyRelease("Space");
                          }
                        : undefined
                    }
                    style={({ pressed }) => [
                      styles.key,
                      wide && styles.keyWide,
                      {
                        backgroundColor: active ? t.accent : t.surfaceContainerHigh,
                        borderColor: t.outline,
                        transitionProperty: "transform",
                      },
                      pressed && { transform: [{ scale: 0.95 }], opacity: 0.8 },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={k === "⌫" ? "Backspace" : k === "⇧" ? "Shift" : k}
                  >
                    <Text
                      style={[
                        styles.keyText,
                        { color: active ? t.onPrimary : t.onSurface },
                      ]}
                      adjustsFontSizeToFit
                    >
                      {display(k)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
          {/* Space row */}
          <View style={styles.row}>
            <Pressable
              onPress={() => handleSpecial(" ")}
              style={({ pressed }) => [
                styles.key,
                styles.keySpace,
                { backgroundColor: t.surfaceContainerHigh, borderColor: t.outline },
                pressed && { transform: [{ scale: 0.98 }], opacity: 0.8 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Space"
            >
              <Text style={[styles.keyText, { color: t.onSurface }]} adjustsFontSizeToFit>
                space
              </Text>
            </Pressable>
            <M3IconButton
              glyph="↵"
              label="Enter"
              onPress={() => void shortcut(["Enter"])}
              style={styles.keyEnt}
            />
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    padding: 16,
    gap: 14,
  },
  batcherWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  batcher: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    lineHeight: 20,
    minHeight: 46,
  },
  flushChip: {
    backgroundColor: "#65558F",
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignSelf: "stretch",
  },
  flushChipText: {
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 17,
  },
  fnRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  fnSpacer: { flex: 1 },
  grid: {
    gap: 6,
  },
  row: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
  },
  key: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  keyWide: {
    flex: 1.4,
  },
  keySpace: {
    flex: 4,
  },
  keyEnt: {
    flex: 1.4,
  },
  keyText: {
    fontSize: 17,
    fontWeight: "600",
    lineHeight: 22,
  },
});
