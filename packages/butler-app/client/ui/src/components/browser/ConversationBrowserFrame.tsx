import type { ReactNode } from "react";
import { chromeEnvironment } from "@/app/chromeEnvironment";
import { appCopy } from "@/app/copy";
import { AdaptiveShellCard, AdaptiveShellSplit, Stack, useAdaptiveDrawer } from "@/butler-ds";
import { Conversation } from "../conversation/Conversation";
import { BrowserArea } from "./BrowserArea";
import { useBrowserShellState } from "./browserShellState";

export function ConversationBrowserFrame({ sessionId, paneOpen, chatWidth, notice }: {
  sessionId: string; paneOpen: boolean; chatWidth: number; notice?: ReactNode;
}) {
  const drawer = useAdaptiveDrawer(chromeEnvironment());
  if (!paneOpen && !drawer) return <AdaptiveShellCard><Stack fill gap="none">{notice}<Conversation /></Stack></AdaptiveShellCard>;
  return <Stack fill gap="none">{notice}<AdaptiveShellSplit paneOpen={paneOpen} chatWidth={chatWidth}
    onChatWidthChange={useBrowserShellState.getState().setChatWidth} resizeLabel={appCopy.browser.resizeChat} resizeHint={appCopy.titlebar.dragToResize}
    chat={<Conversation />} pane={<BrowserArea sessionId={sessionId} />} /></Stack>;
}
