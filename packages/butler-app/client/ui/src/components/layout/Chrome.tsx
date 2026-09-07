import {
  ChromeFloatingToggleLayer,
  PanelLeft,
} from "@/butler-ds";
import { IconButton } from "@/butler-ds";
import { useButlerStore } from "@/app/store.ts";

export function WindowChromeLayer({
  leftOpen: leftOpenProp,
  onToggle,
}: {
  leftOpen?: boolean;
  onToggle?: () => void;
} = {}) {
  const storeLeftOpen = useButlerStore((state) => state.leftOpen);
  const setLeftOpen = useButlerStore((state) => state.setLeftOpen);
  const leftOpen = leftOpenProp ?? storeLeftOpen;
  const toggle = onToggle ?? (() => setLeftOpen((value) => !value));

  // The open sidebar owns its close control beside the brand.
  if (leftOpen) return null;

  return (
    <ChromeFloatingToggleLayer>
      <IconButton
        label="Show sidebar"
        onClick={toggle}
      >
        <PanelLeft size={16} />
      </IconButton>
    </ChromeFloatingToggleLayer>
  );
}
