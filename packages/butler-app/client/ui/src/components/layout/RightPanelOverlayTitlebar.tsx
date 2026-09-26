import { useAppLocale } from "@/app/copy.ts";
import {
  AdaptivePanelTitlebar,
  IconButton,
  PanelRightClose,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";

export function RightPanelOverlayTitlebar() {
  useAppLocale();
  const setRightOpen = useButlerStore((state) => state.setRightOpen);

  return (
    <AdaptivePanelTitlebar
      windowDrag="drag"
      data-test-class="right-panel-overlay-titlebar"
      open
    >
      <IconButton
        data-test-class="right-panel-overlay-close"
        label={appCopy.titlebar.hideRightPanel}
        selected
        onClick={() => setRightOpen(false)}
      >
        <PanelRightClose size="md" />
      </IconButton>
    </AdaptivePanelTitlebar>
  );
}
