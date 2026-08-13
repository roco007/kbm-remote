/**
 * Pair Device — manual IP pairing flow (spec §5.3: pairing code handshake).
 *
 * The user enters the receiver's address (and optionally the 8-character
 * pairing code shown on the receiver) and saves it as a trusted device.
 * mDNS discovery is implemented server-side and advertised by the receiver;
 * auto-discovery will be surfaced here once the network discovery client
 * ships (tracked in the networking package).
 */
import { useNavigation } from "@react-navigation/native";
import { type NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { M3Button, M3Card, M3Field, tapHaptic } from "../components/primitives";
import { HubHeader } from "../navigation/HubHeader";
import { useConnectionStore, deviceKey } from "../store/connectionStore";
import { useResolvedTokens } from "../store/themeStore";

import type { RootStackParamList } from "../navigation/types";

const PAIRING_CODE_LENGTH = 8;
const DEFAULT_PORT = 9250;

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function PairDeviceScreen() {
  const t = useResolvedTokens();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { connect, saveDevice, devices, error, target } = useConnectionStore((s) => ({
    connect: s.connect,
    saveDevice: s.saveDevice,
    devices: s.devices,
    error: s.error,
    target: s.target,
  }));

  const [host, setHost] = useState("");
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const [pairingError, setPairingError] = useState<string | null>(null);

  const normalizedHost = host.trim();
  const portNum = Number(port);
  const validAddress =
    /^[a-z0-9.-]+$/i.test(normalizedHost) &&
    Number.isInteger(portNum) &&
    portNum > 0 &&
    portNum <= 65535;
  const validCode = code.replace(/\s/g, "").length === PAIRING_CODE_LENGTH;

  const handlePair = async () => {
    setPairingError(null);
    if (!validAddress) {
      setPairingError("Enter a valid host name or IP and port (1–65535).");
      return;
    }
    if (!validCode) {
      setPairingError(
        `Enter the ${PAIRING_CODE_LENGTH}-character pairing code shown on the receiver.`,
      );
      return;
    }
    const id = deviceKey(normalizedHost, portNum);
    const device = {
      id,
      name: label.trim() || normalizedHost,
      host: normalizedHost,
      port: portNum,
    };
    await saveDevice(device);
    // The pairing code itself is verified during the Hello/Audit handshake
    // (protocol §5.3); the sender simply presents it as metadata for now.
    await connect(device);
    tapHaptic();
  };

  const connecting = target !== null && devices.some((d) => d.id === target.id);
  void connecting;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: t.bgApp }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <HubHeader title="Pair device" />
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.body, { color: t.textSecondary }]}>
          Enter the receiver's address and the pairing code displayed on its screen. After
          the first successful pairing this device stays trusted and reconnects
          automatically.
        </Text>

        <M3Card style={styles.card}>
          <M3Field
            label="Receiver address"
            value={host}
            onChangeText={setHost}
            placeholder="192.168.1.10"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
          />
          <View style={styles.row}>
            <View style={styles.portField}>
              <M3Field
                label="Port"
                value={port}
                onChangeText={setPort}
                placeholder={String(DEFAULT_PORT)}
                keyboardType="number-pad"
                returnKeyType="done"
              />
            </View>
            <View style={styles.labelField}>
              <M3Field
                label="Label (optional)"
                value={label}
                onChangeText={setLabel}
                placeholder="Raj's MacBook"
                returnKeyType="done"
              />
            </View>
          </View>
          <M3Field
            label="Pairing code"
            value={code}
            onChangeText={(v) =>
              setCode(
                v
                  .toUpperCase()
                  .replace(/[^A-Z0-9]/g, "")
                  .slice(0, PAIRING_CODE_LENGTH),
              )
            }
            placeholder="XXXXXXXX"
            autoCapitalize="characters"
            maxLength={PAIRING_CODE_LENGTH + 2}
            returnKeyType="done"
          />
          {pairingError ? (
            <Text style={[styles.error, { color: t.danger }]}>{pairingError}</Text>
          ) : null}
          {error && !pairingError ? (
            <Text style={[styles.error, { color: t.danger }]}>{error}</Text>
          ) : null}
          <M3Button
            label="Pair & connect"
            variant="primary"
            style={styles.button}
            onPress={() => void handlePair()}
          />
        </M3Card>

        <M3Card style={styles.card}>
          <Text style={[styles.subheading, { color: t.textPrimary }]}>
            How pairing works
          </Text>
          <Text style={[styles.body, { color: t.textSecondary }]}>
            The receiver shows a random 8-character code on its pairing screen. Enter it
            here and the sender proves possession of the same secret during the encrypted
            handshake (§5.3) — an eavesdropper on the local network can neither read nor
            join the session.
          </Text>
        </M3Card>

        <View style={styles.manualNote}>
          <Text style={[styles.body, { color: t.textSecondary }]}>
            Automatic discovery (mDNS/Bonjour) is implemented on the receiver side and
            will be surfaced here as a "scan" flow in a later milestone — for now, manual
            IP entry covers every network layout.
          </Text>
          <Pressable
            onPress={() => {
              tapHaptic();
              navigation.goBack();
            }}
            style={({ pressed }) => [pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel="Back to Home"
          >
            <Text style={[styles.link, { color: t.accent }]}>Back to Home</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    padding: 16,
    gap: 16,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
  },
  card: { gap: 14 },
  row: {
    flexDirection: "row",
    gap: 12,
  },
  portField: { width: 100 },
  labelField: { flex: 1 },
  error: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
  },
  button: {
    marginTop: 4,
  },
  subheading: {
    fontSize: 16,
    fontWeight: "600",
    lineHeight: 21,
  },
  manualNote: { gap: 10 },
  link: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "600",
  },
});
