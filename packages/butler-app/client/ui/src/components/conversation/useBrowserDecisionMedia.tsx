import { canOpenHandoffTab } from "../browser/browserHandoff";
import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import type { AuthorityApprovalCard } from "@/app/types";
import { LiveTabFrame, type ComposerDecisionMedia } from "@/butler-ds";
import { openConversationBrowser, useBrowserState } from "../browser/browserBridge";
import { familyAgentTabs } from "../browser/conversationAgentTabs";
import { useRightSlot } from "../file-viewer/useRightSlot";
import { useConversationFamily } from "../browser/useConversationAgentTabs";
import { useDocumentVisible, useLiveFrames } from "../browser/useLiveFrames";

/** The thumbnail owns its frame stream, so frames re-render only this leaf, never the composer. */
function DecisionTabFrame({ session, tab, favicon }: { session: string; tab: string; favicon: string }) {
  // Paused only while the browser itself shows the tab: open behind the file viewer, it is not on screen.
  const browserShown = useRightSlot(session) === "browser";
  const visible = useDocumentVisible();
  // Full width: under 420px the DS shows the thumbnail as wide as the text column.
  const frames = useLiveFrames([tab], 416, browserShown || !visible);
  return <LiveTabFrame frame={frames[tab]} favicon={favicon} />;
}

/** Use the exact pending operation's tab, within the conversation's ownership roll-up. */
export function useBrowserDecisionMedia(request: AuthorityApprovalCard | undefined): ComposerDecisionMedia | undefined {
  const session = useButlerStore(state => state.activeChatId);
  const family = useConversationFamily(session);
  const operation = request?.approval?.operation;
  const id = operation?.tool.startsWith("browser_") ? operation.browser_tab : undefined;
  // Primitive selections: browser publishes re-render the composer only when the thumbnail's own facts change.
  const target = (tabs: Parameters<typeof familyAgentTabs>[1]) => id ? familyAgentTabs(family, tabs.filter(tab => tab.id === id))[0] : undefined;
  const favicon = useBrowserState(state => target(state.tabs)?.favicon);
  const title = useBrowserState(state => target(state.tabs)?.title);
  if (!canOpenHandoffTab() || !id || title === undefined) return undefined;
  const copy = appCopy.browser;
  return { content: <DecisionTabFrame session={session} tab={id} favicon={favicon ?? ""} />,
    label: `${copy.rail.openToCheck} · ${title || copy.newTab}`, onOpen: () => void openConversationBrowser(session, id) };
}
