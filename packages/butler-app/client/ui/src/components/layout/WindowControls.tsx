import { ButtonContainer, IconButton, Minus, Square, X } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import {
  closeNativeWindow,
  minimizeNativeWindow,
  shouldShowAppWindowControls,
  toggleNativeWindowMaximize,
} from "@/app/nativeWindowControls.ts";

export function WindowControls() {
  if (!shouldShowAppWindowControls()) return null;

  return (
    <ButtonContainer size="icon-sm" data-test-class="app-window-controls">
      <IconButton
        data-test-class="app-window-minimize"
        label={appCopy.titlebar.minimizeWindow}
        onClick={() => void minimizeNativeWindow()}
      >
        <Minus size={15} />
      </IconButton>
      <IconButton
        data-test-class="app-window-maximize"
        label={appCopy.titlebar.maximizeWindow}
        onClick={() => void toggleNativeWindowMaximize()}
      >
        <Square size={14} />
      </IconButton>
      <IconButton
        data-test-class="app-window-close"
        label={appCopy.titlebar.closeWindow}
        onClick={() => void closeNativeWindow()}
      >
        <X size={15} />
      </IconButton>
    </ButtonContainer>
  );
}
