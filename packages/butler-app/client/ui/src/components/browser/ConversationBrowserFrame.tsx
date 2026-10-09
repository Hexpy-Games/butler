import { appCopy } from "@/app/copy";
import { AdaptiveShellSplit } from "@/butler-ds";
import { Conversation } from "../conversation/Conversation";
import { BrowserArea } from "./BrowserArea";
import { useBrowserShellState } from "./browserShellState";

export function ConversationBrowserFrame({ sessionId, paneOpen, chatWidth }: {
  sessionId: string; paneOpen: boolean; chatWidth: number;
}) {
  return <AdaptiveShellSplit paneOpen={paneOpen} chatWidth={chatWidth}
    onChatWidthChange={useBrowserShellState.getState().setChatWidth} resizeLabel={appCopy.browser.resizeChat} resizeHint={appCopy.titlebar.dragToResize}
    chat={<Conversation />} pane={<BrowserArea sessionId={sessionId} />} />;
}
