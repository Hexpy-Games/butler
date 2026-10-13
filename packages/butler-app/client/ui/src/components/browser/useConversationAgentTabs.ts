import { useMemo } from "react";
import { useButlerStore } from "@/app/store";
import { useBrowserState, type BrowserTab } from "./browserBridge";
import { conversationAgentTabs } from "./conversationAgentTabs";

export function agentTabState(tab: BrowserTab) {
  if (tab.waiting || tab.signinStep || tab.payStep || tab.dialog) return "attention";
  if (tab.busy || tab.inUse) return "busy";
  if (tab.status === "crashed") return "error";
  if (tab.holder === "user") return "held";
  return "idle";
}
const priority = { attention: 0, busy: 1, error: 2, held: 3, idle: 3 };
export function useConversationAgentTabs(session: string) {
  const tabs = useBrowserState(state => state.tabs);
  const views = useButlerStore(state => state.sessionViews);
  return useMemo(() => conversationAgentTabs(session, tabs, views).sort((a, b) =>
    priority[agentTabState(a)] - priority[agentTabState(b)] || (b.lastAgentCall ?? 0) - (a.lastAgentCall ?? 0)), [session, tabs, views]);
}
