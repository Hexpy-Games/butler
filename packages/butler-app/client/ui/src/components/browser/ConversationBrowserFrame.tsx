import { useEffect, useState, type ReactNode } from "react";
import { ImageEditor } from "../images/ImageEditor";
import { closeImageEditor, useImageEditorState } from "../images/imageEditorState";
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
import { useBrowserState } from "./browserBridge";
import { useBrowserShellState } from "./browserShellState";

/**
 * The conversation and its right slot. The browser and the file viewer share the slot: the slot slides in
 * once; a swap between the two does not slide it again (the viewer fades its page in; the browser's native view cannot fade).
 */
export function ConversationBrowserFrame({ sessionId, pane, chatWidth, notice }: {
  sessionId: string; pane: RightSlotPane; chatWidth: number; notice?: ReactNode;
}) {
  const target = useImageEditorState(s => s.target);
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 767px)").matches);
  useEffect(() => { const media = matchMedia("(max-width: 767px)"); const change = () => setMobile(media.matches);
    media.addEventListener("change", change); return () => media.removeEventListener("change", change); }, []);
  useEffect(() => { if (target && target.session !== sessionId) closeImageEditor(); }, [target, sessionId]);
  const editing = target?.session === sessionId ? target : undefined;
  const editor = editing ? <ImageEditor key={`${editing.session}:${editing.asset.id}`} session={sessionId} initial={editing.asset} /> : undefined;
  const drawer = useAdaptiveDrawer(chromeEnvironment());
  // A saved open pane comes up when the bridge first reports it enabled: that restores it, it does not open it.
  const bridgeEnabled = useBrowserState((state) => state.enabled);
  if (editor && mobile) return <AdaptiveShellCard>{editor}</AdaptiveShellCard>;
  // A phone has no room beside the chat: the viewer takes the workspace, and its back button returns to the chat
  // (the files stay open behind '파일 보기').
  if (!editor && drawer && pane === "viewer") return <FileViewerPane documentPage={renderDocument} sessionId={sessionId} notice={notice}
    onBack={() => useFileViewerState.getState().setShown(sessionId, false)} />;
  // One tree open or closed: the conversation stays mounted, so it keeps its scroll and the pane can move beside it.
  const open = pane !== null || Boolean(editor);
  return <Stack fill gap="none">{open || drawer ? notice : null}<AdaptiveShellSplit paneOpen={open} contextKey={`${sessionId}:${bridgeEnabled}`} chatWidth={chatWidth}
    onChatWidthChange={useBrowserShellState.getState().setChatWidth} resizeLabel={appCopy.browser.resizeChat} resizeHint={appCopy.titlebar.dragToResize}
    chat={<Stack fill gap="none">{open || drawer ? null : notice}<Conversation /></Stack>} pane={editor ?? (pane === "browser" ? <BrowserArea sessionId={sessionId} />
      : pane === "viewer" ? <FileViewerPane documentPage={renderDocument} sessionId={sessionId} /> : undefined)} /></Stack>;
}

/** A document in the viewer: the viewer's back and close sit in the document's own title row. */
const renderDocument: DocumentPageRenderer = (id, controls) => <DocumentPage id={id} {...controls} />;
