/**
 * Home (S1) — device roster and connection entry point.
 *
 * Lists paired devices from the connection store, shows live connection
 * state via M3StatusChip, and navigates to the control hub once a session
 * is authenticated. Pairing entry point lives on PairDevice.
 */
import { type NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useMemo } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { M3Button, M3Card, M3StatusChip, tapHaptic } from "../components/primitives";
import { useConnectionStore, deviceKey } from "../store/connectionStore";
import { useResolvedTokens } from "../store/themeStore";

import type { RootStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<RootStackParamList, "Home">;

export default function HomeScreen({ navigation }: Props) {
  const t = useResolvedTokens();
  const insets = useSafeAreaInsets();
  const { devices, state, target, error, connect, disconnect, removeDevice } =
    useConnectionStore((s) => ({
      devices: s.devices,
      state: s.state,
      target: s.target,
      error: s.error,
      connect: s.connect,
      disconnect: s.disconnect,
      removeDevice: s.removeDevice,
    }));

  const connected = state === "connected";
  // `connecting` covers the transient in-flight phases of the client state
  // machine (connecting → connected → authenticated → reconnecting).
  const connecting = state === "connecting" || state === "reconnecting";

  const statusChip = useMemo(() => {
    switch (state) {
      case "connected":
      case "authenticated":
        return {
          text: `Connected${target ? ` · ${target.name}` : ""}`,
          tone: "success" as const,
        };
      case "connecting":
      case "reconnecting":
        return { text: "Connecting…", tone: "warning" as const };
      case "disconnected":
        return error
          ? { text: error, tone: "danger" as const }
          : { text: "Disconnected", tone: "neutral" as const };
      default:
        return { text: "Idle", tone: "neutral" as const };
    }
  }, [state, target, error]);

  const handleConnect = useCallback(
    (host: string, port: number) => {
      void connect({ id: deviceKey(host, port), name: host, host, port });
    },
    [connect],
  );

  const handleDisconnect = useCallback(() => {
    disconnect();
  }, [disconnect]);

  return (
    <View style={[styles.root, { backgroundColor: t.bgApp, paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        <Text style={[styles.title, { color: t.textPrimary }]}>KBM Remote</Text>
        <M3StatusChip text={statusChip.text} tone={statusChip.tone} />
      </View>

      <FlatList
        data={devices}
        keyExtractor={(d) => d.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <Text style={[styles.sectionLabel, { color: t.textSecondary }]}>
            Paired devices
          </Text>
        }
        ListEmptyComponent={
          <M3Card style={styles.emptyCard}>
            <Text style={[styles.emptyText, { color: t.textSecondary }]}>
              No paired devices yet. Pair with your receiver to start controlling it.
            </Text>
            <M3Button
              label="Pair device"
              variant="primary"
              style={styles.emptyButton}
              onPress={() => navigation.navigate("PairDevice")}
            />
          </M3Card>
        }
        renderItem={({ item }) => (
          <M3Card style={styles.deviceCard}>
            <View style={styles.deviceRow}>
              <View style={styles.deviceInfo}>
                <Text style={[styles.deviceName, { color: t.textPrimary }]}>
                  {item.name}
                </Text>
                <Text style={[styles.deviceAddr, { color: t.textSecondary }]}>
                  {item.host}:{item.port}
                </Text>
              </View>
              {connected && target?.id === item.id ? (
                <M3Button
                  label="Disconnect"
                  variant="secondary"
                  onPress={handleDisconnect}
                />
              ) : (
                <M3Button
                  label={connecting ? "Connecting…" : "Connect"}
                  variant="primary"
                  loading={connecting}
                  disabled={connecting}
                  onPress={() => handleConnect(item.host, item.port)}
                />
              )}
            </View>
            <Pressable
              onPress={() => {
                tapHaptic();
                void removeDevice(item.id);
              }}
              style={({ pressed }) => [styles.remove, pressActive(pressed)]}
              accessibilityRole="button"
              accessibilityLabel={`Forget ${item.name}`}
            >
              <Text style={[styles.removeText, { color: t.danger }]}>Forget device</Text>
            </Pressable>
          </M3Card>
        )}
      />

      {connected ? (
        <View style={[styles.hubRow, { paddingBottom: insets.bottom + 16 }]}>
          <M3Button
            label="Open controls"
            variant="primary"
            style={styles.hubButton}
            onPress={() => navigation.navigate("Touchpad")}
          />
          <M3Button
            label="Settings"
            variant="secondary"
            style={styles.hubButton}
            onPress={() => navigation.navigate("Settings")}
          />
        </View>
      ) : (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
          <M3Button
            label="Pair a new device"
            variant="text"
            onPress={() => navigation.navigate("PairDevice")}
          />
        </View>
      )}
    </View>
  );
}

function pressActive(pressed: boolean) {
  return pressed ? { opacity: 0.6 } : undefined;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  title: { fontSize: 28, fontWeight: "700", lineHeight: 34 },
  list: { padding: 16, gap: 12 },
  sectionLabel: { fontSize: 13, fontWeight: "600", marginBottom: 6 },
  deviceCard: { gap: 12 },
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  deviceInfo: { flex: 1 },
  deviceName: { fontSize: 17, fontWeight: "600", lineHeight: 22 },
  deviceAddr: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  emptyCard: { alignItems: "center", gap: 8 },
  emptyText: { fontSize: 15, lineHeight: 21, textAlign: "center" },
  emptyButton: { alignSelf: "stretch", marginTop: 8 },
  remove: { alignSelf: "flex-start" },
  removeText: { fontSize: 13, lineHeight: 18, fontWeight: "500" },
  hubRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 12,
  },
  hubButton: { flex: 1 },
  footer: { alignItems: "center", paddingTop: 8 },
});
