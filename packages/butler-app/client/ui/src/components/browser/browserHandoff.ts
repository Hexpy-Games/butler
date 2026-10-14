import { useButlerStore } from "@/app/store";
import { conversationAgentTabs } from "./conversationAgentTabs";
import { browserCall, openConversationBrowser, type BrowserSnapshot } from "./browserBridge";

/** A hand-off opens the tab only where the App has a browser (not on a phone). */
export function canOpenHandoffTab(): boolean {
  return typeof window !== "undefined" && Boolean(window.butlerBrowser);
}

/** Opens and focuses the conversation's tab that waits on the user. */
export async function openHandoffTab(sessionId: string): Promise<void> {
  if (!canOpenHandoffTab()) return;
  const snapshot = await browserCall("state") as BrowserSnapshot | undefined;
  const tabs = conversationAgentTabs(sessionId, snapshot?.tabs ?? [], useButlerStore.getState().sessionViews);
  const tab = tabs.find(item => item.signinStep || item.payStep) ?? tabs.find(item => item.waiting);
  await openConversationBrowser(sessionId, tab?.id);
}
