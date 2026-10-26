import type { ReactNode } from "react";
import { chromeEnvironment } from "@/app/chromeEnvironment";
import { appCopy } from "@/app/copy";
import { useFileViewerState } from "@/app/fileViewerState";
import { AdaptiveShellCard, AdaptiveShellSplit, Stack, useAdaptiveDrawer } from "@/butler-ds";
import { Conversation } from "../conversation/Conversation";
import { DocumentPage } from "../documents/DocumentPage";
import type { DocumentPageRenderer } from "../file-viewer/FileViewerDocument";
import { FileViewerPane } from "../file-viewer/FileViewerPane";
import type { RightSlotPane } from "../file-viewer/useRightSlot";
import { BrowserArea } from "./BrowserArea";
import { useBrowserShellState } from "./browserShellState";

/**
 * The conversation and its right slot. The browser and the file viewer share the slot: the slot slides in
 * once; a swap between the two does not slide it again (the viewer fades its page in; the browser's native view cannot fade).
 */
export function ConversationBrowserFrame({ sessionId, pane, chatWidth, notice }: {
  sessionId: string; pane: RightSlotPane; chatWidth: number; notice?: ReactNode;
}) {
  const drawer = useAdaptiveDrawer(chromeEnvironment());
  if (!pane && !drawer) return <AdaptiveShellCard><Stack fill gap="none">{notice}<Conversation /></Stack></AdaptiveShellCard>;
  // A phone has no room beside the chat: the viewer takes the workspace, and its back button returns to the chat
  // (the files stay open behind '파일 보기').
  if (drawer && pane === "viewer") return <FileViewerPane documentPage={renderDocument} sessionId={sessionId} notice={notice}
    onBack={() => useFileViewerState.getState().setShown(sessionId, false)} />;
  return <Stack fill gap="none">{notice}<AdaptiveShellSplit paneOpen={pane !== null} chatWidth={chatWidth}
    onChatWidthChange={useBrowserShellState.getState().setChatWidth} resizeLabel={appCopy.browser.resizeChat} resizeHint={appCopy.titlebar.dragToResize}
    chat={<Conversation />} pane={pane === "browser" ? <BrowserArea sessionId={sessionId} />
      : pane === "viewer" ? <FileViewerPane documentPage={renderDocument} sessionId={sessionId} /> : undefined} /></Stack>;
}

/** A document in the viewer: the viewer's back and close sit in the document's own title row. */
const renderDocument: DocumentPageRenderer = (id, controls) => <DocumentPage id={id} {...controls} />;
