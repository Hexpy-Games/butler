import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import type { AuthorityApprovalCard } from "@/app/types";
import { LiveTabFrame, type ComposerDecisionMedia } from "@/butler-ds";
import { openConversationBrowser } from "../browser/browserBridge";
import { useConversationAgentTabs } from "../browser/useConversationAgentTabs";
import { useBrowserShellState } from "../browser/browserShellState";
import { useDocumentVisible, useLiveFrames } from "../browser/useLiveFrames";

/** Use the exact pending operation's tab, within the conversation's ownership roll-up. */
export function useBrowserDecisionMedia(request: AuthorityApprovalCard | undefined): ComposerDecisionMedia | undefined {
  const session = useButlerStore(state => state.activeChatId);
  const open = useBrowserShellState(state => Boolean(state.conversations[session]?.open));
  const visible = useDocumentVisible();
  const tabs = useConversationAgentTabs(session);
  const operation = request?.approval?.operation;
  const tab = operation?.tool.startsWith("browser_") ? tabs.find(tab => tab.id === operation.browser_tab) : undefined;
  const frames = useLiveFrames(tab && !open && visible ? [tab.id] : [], 288);
  if (!tab) return undefined;
  return { content: <LiveTabFrame frame={frames[tab.id]} favicon={tab.favicon} />,
    label: appCopy.browser.rail.openToCheck, onOpen: () => void openConversationBrowser(session, tab.id) };
}
