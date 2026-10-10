import { browserCall, openConversationBrowser, type BrowserSnapshot } from "./browserBridge";

/** A hand-off opens the tab only where the App has a browser (not on a phone). */
export function canOpenHandoffTab(): boolean {
  return typeof window !== "undefined" && Boolean(window.butlerBrowser);
}

/** Opens and focuses the conversation's tab that waits on the user. */
export async function openHandoffTab(sessionId: string): Promise<void> {
  const snapshot = await browserCall("state") as BrowserSnapshot | undefined;
  const tabs = snapshot?.tabs.filter(tab => tab.owner === `conversation:${sessionId}`) ?? [];
  const tab = tabs.find(item => item.signinStep) ?? tabs.find(item => item.waiting);
  await openConversationBrowser(sessionId, tab?.id);
}
