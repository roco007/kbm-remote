/**
 * Presentation store (Zustand) — lightweight slide state for the
 * Presentation Mode screen.
 *
 * The receiver executes the real slide transitions; the sender only tracks
 * how many `next`/`prev` commands it has sent so the counter UI reflects
 * optimistic state. Entering presentation mode activates expo-keep-awake
 * (via the screen component calling the exported helpers) so a long talk
 * does not dim the phone.
 */
import { create } from "zustand";

export interface PresentationState {
  /** Optimistic slide counter — 0-based relative to session start. */
  slideIndex: number;
  active: boolean;
  goTo: (direction: "next" | "prev") => void;
  setActive: (active: boolean) => void;
  reset: () => void;
}

export const usePresentationStore = create<PresentationState>((set) => ({
  slideIndex: 0,
  active: false,
  goTo: (direction) =>
    set((state) => ({
      slideIndex:
        direction === "next" ? state.slideIndex + 1 : Math.max(0, state.slideIndex - 1),
    })),
  setActive: (active) => set({ active }),
  reset: () => set({ slideIndex: 0, active: false }),
}));
