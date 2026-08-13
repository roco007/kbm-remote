/**
 * @kbm-remote/sender entry — stack navigator (React Navigation 7).
 *
 * Boots in this order:
 *   1. Hydrate persisted stores (theme / settings / clipboard / devices)
 *      before the first render so no flash of default values.
 *   2. Mount the NavigationContainer with the typed route map
 *      (src/navigation/types.ts — one source of truth for all routes).
 *   3. Register the stack: Home → [PairDevice | control hub screens | Settings].
 *
 * Screen wiring (UX Design Document §4):
 *   Home (S1) — device roster and connection entry point
 *   PairDevice (S2) — manual IP + pairing-code pairing flow
 *   Touchpad (S3) — gesture-driven mouse control
 *   Keyboard (S4) — QWERTY grid with modifier toggles
 *   MediaControls (S5) — transport + volume buttons
 *   Clipboard (S6) — remote clipboard pull / text push / history
 *   PresentationMode (S8) — full-screen slide control with keep-awake
 *   Settings (S9) — theme, sensitivity, scroll speed, haptics
 *
 * File transfer (S7) lands in a later milestone.
 */
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";

import { type RootStackParamList } from "./navigation/types";
import {
  ClipboardScreen,
  HomeScreen,
  KeyboardScreen,
  MediaControlsScreen,
  PairDeviceScreen,
  PresentationModeScreen,
  SettingsScreen,
  TouchpadScreen,
} from "./screens";
import { hydrateClipboard } from "./store/clipboardStore";
import { hydrateSettings } from "./store/settingsStore";
import { hydrateTheme } from "./store/themeStore";

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const [ready, setReady] = useState(false);

  // Hydrate every persisted store before rendering — screens read these at
  // mount, so hydration races would show stale defaults for one frame.
  const hydrate = useCallback(async () => {
    await Promise.all([hydrateTheme(), hydrateSettings(), hydrateClipboard()]);
    setReady(true);
  }, []);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  if (!ready) {
    // Minimal splash: the stores hydrate in a few ms; the themed root paints
    // over this placeholder on first frame.
    return null;
  }

  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName="Home"
        screenOptions={{
          headerShown: false,
          animation: "slide_from_right",
          animationDuration: 220,
        }}
      >
        <Stack.Screen name="Home" component={HomeScreen} />
        <Stack.Screen name="PairDevice" component={PairDeviceScreen} />
        <Stack.Screen name="Touchpad" component={TouchpadScreen} />
        <Stack.Screen name="Keyboard" component={KeyboardScreen} />
        <Stack.Screen name="MediaControls" component={MediaControlsScreen} />
        <Stack.Screen name="Clipboard" component={ClipboardScreen} />
        <Stack.Screen name="PresentationMode" component={PresentationModeScreen} />
        <Stack.Screen name="Settings" component={SettingsScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// Type-only re-export used by tests / deep links.
export type { RootStackParamList } from "./navigation/types";
