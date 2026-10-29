import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { useFileViewerState, useSessionFiles } from "@/app/fileViewerState";
import { FileText, IconButton } from "@/butler-ds";
import { useRightSlot } from "./useRightSlot";

/**
 * '파일 보기': shown while the conversation has open files, pressed while the viewer holds the right slot.
 * Pressing it hides the viewer (the files stay open) or brings it back in front of the browser.
 */
export function FileViewerToggle() {
  useAppLocale();
  const session = useButlerStore((state) => state.activeChatId);
  const files = useSessionFiles(session);
  const shown = useRightSlot(session) === "viewer";
  if (files.entries.length === 0) return null;
  return <IconButton data-test-class="titlebar-file-viewer-toggle" label={appCopy.fileViewer.title} pane="viewer" pressed={shown}
    tone={shown ? "butler" : "default"}
    onClick={() => useFileViewerState.getState().setShown(session, !shown)}><FileText size="md" /></IconButton>;
}
