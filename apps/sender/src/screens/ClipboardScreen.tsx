/**
 * Clipboard (S6) — view the receiver's clipboard and push/pull text.
 *
 * Flow (spec §3.7, ClipboardQuery 0x71 / ClipboardSync 0x70):
 *   - "Refresh" sends a ClipboardQuery frame; the receiver replies with a
 *     ClipboardSync frame that the connection manager routes to the store
 *     (wiring lands when the frame router is plugged in — for now the pull
 *     button shows the optimistic flow and notes the router is pending).
 *   - "Send to device" transmits the typed text as ClipboardSync (fire and
 *     forget) and records it in local history.
 *   - History entries are tappable: tapping re-sends them.
 *
 * History persistence, caps, and entry dedupe live in `clipboardStore`.
 */
import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { M3Button, M3Field, M3StatusChip, tapHaptic } from "../components/primitives";
import { HubHeader } from "../navigation/HubHeader";
import { clipboardQuery, clipboardSync } from "../services/inputDispatch";
import { useClipboardStore } from "../store/clipboardStore";
import { MAX_ITEM_BYTES } from "../store/clipboardStore";
import { useResolvedTokens } from "../store/themeStore";

export default function ClipboardScreen() {
  const t = useResolvedTokens();
  const insets = useSafeAreaInsets();
  const { history, remote, syncing, recordSent, setSyncing } = useClipboardStore((s) => ({
    history: s.history,
    remote: s.remote,
    syncing: s.syncing,
    recordSent: s.recordSent,
    setSyncing: s.setSyncing,
  }));
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 1800);
  }, []);

  const handleSend = useCallback(() => {
    if (!draft.trim()) return;
    tapHaptic();
    const ok = clipboardSync("text", draft.trim());
    if (ok) void recordSent(draft.trim());
    setDraft("");
    flash(ok ? "Sent to receiver" : "Not connected — pair a device first");
  }, [draft, recordSent, flash]);

  const handleResend = useCallback(
    (text: string) => {
      tapHaptic();
      const ok = clipboardSync("text", text);
      if (ok) void recordSent(text);
      flash(ok ? "Resent" : "Not connected — pair a device first");
    },
    [recordSent, flash],
  );

  const handlePull = useCallback(() => {
    tapHaptic();
    const ok = clipboardQuery();
    if (ok) {
      setSyncing(true);
      // The receiver answers with a ClipboardSync frame; until the frame
      // router wires receiver→store, surface the optimistic state.
      setTimeout(() => setSyncing(false), 900);
      flash("Requested receiver clipboard…");
    } else {
      flash("Not connected — pair a device first");
    }
  }, [setSyncing, flash]);

  return (
    <View style={{ flex: 1, backgroundColor: t.bgApp }}>
      <HubHeader title="Clipboard" />
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        {notice ? (
          <View
            style={[
              styles.notice,
              { backgroundColor: t.surfaceContainerHigh, borderColor: t.outline },
            ]}
          >
            <Text style={[styles.noticeText, { color: t.textPrimary }]}>{notice}</Text>
          </View>
        ) : null}

        {/* Remote snapshot */}
        <View style={[styles.remoteCard, { borderColor: t.outline }]}>
          <View style={styles.remoteRow}>
            <Text style={[styles.subheading, { color: t.textPrimary }]}>On receiver</Text>
            {syncing ? <M3StatusChip text="Syncing…" tone="warning" /> : null}
          </View>
          <Text
            style={[styles.remoteText, { color: remote ? t.onSurface : t.textSecondary }]}
          >
            {remote ?? "Pull the receiver's clipboard to see it here."}
          </Text>
          <M3Button
            label="Refresh from receiver"
            variant="secondary"
            style={styles.refreshBtn}
            onPress={handlePull}
            loading={syncing}
          />
        </View>

        {/* Push composer */}
        <M3Field
          label="Text to send"
          value={draft}
          onChangeText={setDraft}
          multiline
          style={styles.composer}
          placeholder="Type or paste text to push to the receiver…"
          returnKeyType="send"
          onSubmitEditing={handleSend}
        />
        <Text style={[styles.byteHint, { color: t.textSecondary }]}>
          {new TextEncoder().encode(draft).length} / {MAX_ITEM_BYTES} bytes
        </Text>
        <M3Button
          label="Send to device"
          variant="primary"
          style={styles.sendBtn}
          onPress={handleSend}
        />

        {/* Local history */}
        <Text style={[styles.subheading, { color: t.textPrimary }]}>
          History{history.length > 0 ? ` · ${history.length}` : ""}
        </Text>
        {history.length === 0 ? (
          <Text style={[styles.emptyText, { color: t.textSecondary }]}>
            Nothing sent yet. Every pushed snippet appears here so you can resend it with
            one tap.
          </Text>
        ) : (
          <View style={styles.historyList}>
            {history.map((entry, i) => (
              <Pressable
                key={`${entry.at}-${i}`}
                onPress={() => handleResend(entry.text)}
                style={({ pressed }) => [
                  styles.historyItem,
                  { borderColor: t.outlineVariant },
                  pressed && { backgroundColor: t.surfaceContainer, opacity: 0.85 },
                ]}
                accessibilityRole="button"
                accessibilityLabel={`Resend ${entry.text.slice(0, 40)}`}
              >
                <Text
                  style={[styles.historyText, { color: t.textPrimary }]}
                  numberOfLines={2}
                >
                  {entry.text}
                </Text>
                <Text style={[styles.historyTime, { color: t.textSecondary }]}>
                  {new Date(entry.at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    padding: 16,
    gap: 14,
  },
  notice: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignSelf: "flex-start",
  },
  noticeText: {
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 17,
  },
  remoteCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  remoteRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  remoteText: {
    fontSize: 15,
    lineHeight: 21,
  },
  refreshBtn: {
    alignSelf: "flex-start",
    marginTop: 4,
  },
  composer: {
    minHeight: 88,
  },
  byteHint: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: -8,
  },
  sendBtn: {},
  subheading: {
    fontSize: 15,
    fontWeight: "600",
    lineHeight: 20,
    marginTop: 4,
  },
  emptyText: {
    fontSize: 14,
    lineHeight: 20,
  },
  historyList: {
    gap: 8,
  },
  historyItem: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
  },
  historyText: {
    fontSize: 15,
    lineHeight: 20,
  },
  historyTime: {
    fontSize: 11,
    lineHeight: 15,
  },
});
