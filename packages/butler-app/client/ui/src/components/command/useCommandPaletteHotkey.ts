import { useHotkey } from "@/butler-ds";
import { useButlerStore } from "@/app/store.ts";

/**
 * Cmd+K (Ctrl+K) toggles the command palette from anywhere in the app shell,
 * the composer included. useHotkey skips IME composition (Korean input) and
 * key repeat; Escape closes the open palette (Dialog).
 */
export function useCommandPaletteHotkey() {
  useHotkey("mod+k", () => {
    const { commandOpen, setCommandOpen } = useButlerStore.getState();
    setCommandOpen(!commandOpen);
  });
}
