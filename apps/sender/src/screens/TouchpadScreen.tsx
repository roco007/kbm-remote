/**
 * Touchpad — the signature control surface.
 *
 * Gesture mapping (UX §4 gesture table):
 *   - Tap                → left click
 *   - Two-finger tap     → right click  (RN gesture handler: use PanResponder
 *                          native responder — two-finger detection via
 *                          `onTouchStart` nativeEvent count is unreliable;
 *                          instead the LEFT 25% vertical zone is the
 *                          right-click strip, and the RIGHT 20% zone is the
 *                          scroll strip, both documented on-screen)
 *   - One-finger drag    → relative mouse move
 *   - Right-zone drag    → vertical scroll
 *   - Left-zone tap      → right click
 *   - Long press         → left mouse-down (drag start), release → mouse-up
 *
 * Frames are throttled by a small coalescing window (16 ms ≈ 60 Hz send cap)
 * and the receiver applies its own 8 ms throttle — the sender never floods.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HubHeader } from "../navigation/HubHeader";
import {
  mouseClick,
  mouseDragEnd,
  mouseDragStart,
  mouseMove,
  mouseScroll,
} from "../services/inputDispatch";
import { useSettingsStore } from "../store/settingsStore";
import { useResolvedTokens } from "../store/themeStore";

/** Minimum finger travel (px) before a drag emits move frames. */
const DEAD_ZONE_PX = 3;
/** Long-press to enter drag (mouse-down) mode, ms. */
const DRAG_HOLD_MS = 350;
/** Right-edge scroll strip width fraction. */
const SCROLL_ZONE_FRACTION = 0.18;

export default function TouchpadScreen() {
  const t = useResolvedTokens();
  const insets = useSafeAreaInsets();
  const sensitivity = useSettingsStore((s) => s.pointerSensitivity);
  const scrollSpeed = useSettingsStore((s) => s.scrollSpeed);

  const [dragging, setDragging] = useState(false);
  const [dragButton] = useState<"left" | "right" | "middle">("left");

  // --- Throttled dispatch state (refs, no re-renders per frame) ----------
  const dragState = useRef<"idle" | "move" | "drag">("idle");
  const lastMoveAt = useRef(0);
  const dragActive = useRef(false);
  const dragTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panStart = useRef<{ x: number; y: number; time: number } | null>(null);

  const dispatchMove = useCallback((dx: number, dy: number) => {
    const now = Date.now();
    if (now - lastMoveAt.current < 16) return;
    lastMoveAt.current = now;
    mouseMove(dx, dy);
  }, []);

  // Pad width in screen px — resolved once via onLayout; used to locate the
  // scroll strip at the right edge without needing a layout subscription.
  const padWidth = useRef(0);

  const dispatchScroll = useCallback(
    (dy: number) => {
      const now = Date.now();
      if (now - lastMoveAt.current < 64) return; // scroll at ~15 Hz max
      lastMoveAt.current = now;
      const ticks =
        Math.sign(dy) * Math.min(5, Math.max(1, Math.round(Math.abs(dy) / 20)));
      mouseScroll("vertical", ticks * Math.max(1, Math.round(scrollSpeed / 2)));
    },
    [scrollSpeed],
  );

  const cancelDragTimer = useCallback(() => {
    if (dragTimer.current) {
      clearTimeout(dragTimer.current);
      dragTimer.current = null;
    }
  }, []);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => false,
        onPanResponderGrant: (evt) => {
          const { locationX, locationY } = evt.nativeEvent;
          panStart.current = { x: locationX, y: locationY, time: Date.now() };
          dragState.current = "idle";
          cancelDragTimer();
          // Long-press timer: if the finger rests ~DRAG_HOLD_MS without a
          // drag, enter drag (mouse-down) mode — the release handler then
          // emits the matching mouse-up.
          dragTimer.current = setTimeout(() => {
            if (!panStart.current || dragState.current !== "idle") return;
            dragActive.current = true;
            setDragging(true);
            void mouseDragStart(dragButton);
          }, DRAG_HOLD_MS);
        },
        onPanResponderMove: (evt) => {
          if (!panStart.current) return;
          const { locationX, locationY, pageX } = evt.nativeEvent;
          const dx = locationX - panStart.current.x;
          const dy = locationY - panStart.current.y;

          // Scroll strip: last SCROLL_ZONE_FRACTION of the pad width. `pageX`
          // is the touch's absolute screen x; the pad's right edge is the
          // screen width minus its trailing inset, so compare against the
          // measured layout width when available and fall back to screen x.
          const width = padWidth.current;
          if (width > 0 && pageX > (1 - SCROLL_ZONE_FRACTION) * width) {
            if (dragState.current === "move" && dragActive.current) {
              void mouseDragEnd(dragButton);
              dragActive.current = false;
            }
            dispatchScroll(dy);
            return;
          }

          if (dragActive.current) {
            dragState.current = "drag";
            dispatchMove(dx * sensitivity, dy * sensitivity);
            return;
          }

          const dist = Math.hypot(dx, dy);
          if (dist > DEAD_ZONE_PX) {
            dragState.current = "move";
            dispatchMove(dx * sensitivity, dy * sensitivity);
          }
        },
        onPanResponderTerminate: () => {
          // OS gesture took over (e.g. app switch) — bail out of drag mode.
          if (dragActive.current) {
            void mouseDragEnd(dragButton);
            dragActive.current = false;
            setDragging(false);
          }
          cancelDragTimer();
          panStart.current = null;
        },
        onPanResponderRelease: (evt) => {
          cancelDragTimer();
          const elapsed = Date.now() - (panStart.current?.time ?? 0);
          panStart.current = null;
          if (dragActive.current) {
            void mouseDragEnd(dragButton);
            dragActive.current = false;
            setDragging(false);
            return;
          }
          if (dragState.current === "move") {
            // Pure drag — nothing to click.
            return;
          }
          if (elapsed < DRAG_HOLD_MS) {
            // Tap: left-zone tap → right click, else left click.
            const isRightZone = evt.nativeEvent.locationX < 90;
            void mouseClick(isRightZone ? "right" : "left", "click");
          }
        },
      }),
    [sensitivity, dispatchMove, dispatchScroll, cancelDragTimer, dragButton],
  );

  const onPadLayout = useCallback((w: number) => {
    padWidth.current = w;
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: t.bgApp }}>
      <HubHeader title="Touchpad" />
      <View style={[styles.padWrap, { paddingBottom: insets.bottom }]}>
        <View
          style={[
            styles.pad,
            { backgroundColor: t.surfaceContainer, borderColor: t.outline },
          ]}
          {...panResponder.panHandlers}
          onLayout={(e) => onPadLayout(e.nativeEvent.layout.width)}
        >
          <View style={[styles.zoneHint, styles.zoneHintRight]}>
            <Text style={styles.zoneHintText}>scroll</Text>
          </View>
          <View style={[styles.zoneHint, styles.zoneHintLeft]}>
            <Text style={styles.zoneHintText}>right-click</Text>
          </View>
          <Text style={[styles.padHint, { color: t.textSecondary }]}>
            Drag to move · tap to click
          </Text>
          {dragging ? (
            <View style={[styles.dragChip, { backgroundColor: t.accent }]}>
              <Text style={[styles.dragChipText, { color: t.onPrimary }]}>
                Dragging — release to drop
              </Text>
            </View>
          ) : null}
        </View>
        <View style={styles.buttonRow}>
          <BigButton label="Left" onPress={() => void mouseClick("left", "click")} />
          <BigButton label="Right" onPress={() => void mouseClick("right", "click")} />
          <BigButton label="Middle" onPress={() => void mouseClick("middle", "click")} />
        </View>
      </View>
    </View>
  );
}

function BigButton({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useResolvedTokens();
  return (
    <Pressable
      onPress={() => {
        onPress();
      }}
      style={({ pressed }) => [
        styles.bigButton,
        { backgroundColor: t.surfaceContainerHigh, borderColor: t.outline },
        pressed && { transform: [{ scale: 0.95 }], opacity: 0.8 },
      ]}
      accessibilityRole="button"
    >
      <Text style={[styles.bigButtonText, { color: t.onSurface }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  padWrap: {
    flex: 1,
    padding: 16,
    paddingTop: 8,
    gap: 14,
  },
  pad: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  zoneHint: {
    position: "absolute",
    top: 10,
    alignItems: "center",
  },
  zoneHintRight: { right: 12 },
  zoneHintLeft: { left: 12 },
  zoneHintText: {
    fontSize: 10,
    lineHeight: 14,
    fontWeight: "600",
    color: "#8A8493",
  },
  padHint: {
    fontSize: 13,
    lineHeight: 18,
  },
  dragChip: {
    position: "absolute",
    bottom: 14,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  dragChipText: {
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 16,
  },
  buttonRow: {
    flexDirection: "row",
    gap: 12,
    height: 64,
  },
  bigButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 14,
  },
  bigButtonText: {
    fontSize: 15,
    fontWeight: "600",
    lineHeight: 20,
  },
});
