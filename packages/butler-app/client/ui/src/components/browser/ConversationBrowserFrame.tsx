import { useEffect, useState, type ReactNode } from "react";
import { ImageEditor } from "../images/ImageEditor";
import { closeImageEditor, useImageEditorState } from "../images/imageEditorState";
import { chromeEnvironment } from "@/app/chromeEnvironment";
import { appCopy } from "@/app/copy";
import { AdaptiveShellCard, AdaptiveShellSplit, Stack, useAdaptiveDrawer } from "@/butler-ds";
import { Conversation } from "../conversation/Conversation";
import { BrowserArea } from "./BrowserArea";
import { useBrowserShellState } from "./browserShellState";

export function ConversationBrowserFrame({ sessionId, paneOpen, chatWidth, notice }: {
  sessionId: string; paneOpen: boolean; chatWidth: number; notice?: ReactNode;
}) {
  const target = useImageEditorState(s => s.target);
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 767px)").matches);
  useEffect(() => { const media = matchMedia("(max-width: 767px)"); const change = () => setMobile(media.matches);
    media.addEventListener("change", change); return () => media.removeEventListener("change", change); }, []);
  useEffect(() => { if (target && target.session !== sessionId) closeImageEditor(); }, [target, sessionId]);
  const editing = target?.session === sessionId ? target : undefined;
  const editor = editing ? <ImageEditor key={`${editing.session}:${editing.asset.id}`} session={sessionId} initial={editing.asset} /> : undefined;
  const drawer = useAdaptiveDrawer(chromeEnvironment());
  if (editor && mobile) return <AdaptiveShellCard>{editor}</AdaptiveShellCard>;
  if (!paneOpen && !drawer && !editor) return <AdaptiveShellCard><Stack fill gap="none">{notice}<Conversation /></Stack></AdaptiveShellCard>;
  return <Stack fill gap="none">{notice}<AdaptiveShellSplit paneOpen={paneOpen || Boolean(editor)} chatWidth={chatWidth}
    onChatWidthChange={useBrowserShellState.getState().setChatWidth} resizeLabel={appCopy.browser.resizeChat} resizeHint={appCopy.titlebar.dragToResize}
    chat={<Conversation />} pane={editor ?? <BrowserArea sessionId={sessionId} />} /></Stack>;
}
