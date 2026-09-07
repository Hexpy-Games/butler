import {
  ChromeFloatingToggleLayer,
  PanelLeft,
  PanelLeftOpen,
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

  return (
    <ChromeFloatingToggleLayer>
      <IconButton
        label={leftOpen ? "Hide sidebar" : "Show sidebar"}
        onClick={toggle}
      >
        {leftOpen ? <PanelLeftOpen size={16} /> : <PanelLeft size={16} />}
      </IconButton>
    </ChromeFloatingToggleLayer>
  );
}
