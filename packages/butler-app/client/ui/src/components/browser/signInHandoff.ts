import { browserCall, openConversationBrowser, type BrowserSnapshot } from "./browserBridge";

/** The sign-in hand-off opens the tab only where the App has a browser (not on a phone). */
export function canOpenSignInTab(): boolean {
  return typeof window !== "undefined" && Boolean(window.butlerBrowser);
}

/** Opens and focuses the conversation's tab that waits on the user's sign-in step. */
export async function openSignInTab(sessionId: string): Promise<void> {
  const snapshot = await browserCall("state") as BrowserSnapshot | undefined;
  const tabs = snapshot?.tabs.filter(tab => tab.owner === `conversation:${sessionId}`) ?? [];
  const tab = tabs.find(item => item.signinStep) ?? tabs.find(item => item.waiting);
  await openConversationBrowser(sessionId, tab?.id);
}
