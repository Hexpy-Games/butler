import { create } from "zustand";
import type { FirstRunProviderCardId } from "@/app/setupProviders.ts";

interface OnboardingStore {
  /** Settings › General "Run setup again" is open. */
  rerunOpen: boolean;
  /** The service the first run just connected; the workspace greets it once. */
  connectedCardId: FirstRunProviderCardId | null;
  openRerun: () => void;
  closeRerun: () => void;
  setConnected: (cardId: FirstRunProviderCardId | null) => void;
}

export const useOnboardingStore = create<OnboardingStore>((set) => ({
  rerunOpen: false,
  connectedCardId: null,
  openRerun: () => set({ rerunOpen: true }),
  closeRerun: () => set({ rerunOpen: false }),
  setConnected: (connectedCardId) => set({ connectedCardId }),
}));
