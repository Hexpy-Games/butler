import {
  ChromeFloatingToggleLayer,
  PanelLeft,
  PanelLeftOpen,
} from "@/butler-ds";
import { IconButton } from "@/butler-ds";
import { useButlerStore } from "@/app/store.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";

export function WindowChromeLayer({
  leftOpen: leftOpenProp,
  onToggle,
}: {
  leftOpen?: boolean;
  onToggle?: () => void;
} = {}) {
  useAppLocale();
  const storeLeftOpen = useButlerStore((state) => state.leftOpen);
  const setLeftOpen = useButlerStore((state) => state.setLeftOpen);
  const leftOpen = leftOpenProp ?? storeLeftOpen;
  const toggle = onToggle ?? (() => setLeftOpen((value) => !value));

  return (
    <ChromeFloatingToggleLayer>
      <IconButton
        label={leftOpen ? appCopy.titlebar.hideLeftPanel : appCopy.titlebar.showLeftPanel}
        onClick={toggle}
      >
        {leftOpen ? <PanelLeftOpen size="md" /> : <PanelLeft size="md" />}
      </IconButton>
    </ChromeFloatingToggleLayer>
  );
}
