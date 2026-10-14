import { useMemo } from "react";
import { useButlerStore } from "@/app/store";
import { useBrowserState, type BrowserTab } from "./browserBridge";
import { conversationFamily, familyAgentTabs } from "./conversationAgentTabs";

export function agentTabState(tab: BrowserTab) {
  if (tab.privacyFrozen || tab.waiting || tab.signinStep || tab.payStep || tab.dialog) return "attention";
  if (tab.busy || tab.inUse) return "busy";
  if (tab.status === "crashed") return "error";
  if (tab.holder === "user") return "held";
  return "idle";
}
const priority = { attention: 0, busy: 1, error: 2, held: 3, idle: 3 };

/** The session ids rolled up into `session`; stable while the family is, so view updates never re-render callers. */
export function useConversationFamily(session: string): readonly string[] {
  const key = useButlerStore((state) => conversationFamily(session, state.sessionViews).join("\n"));
  return useMemo(() => key.split("\n"), [key]);
}

export function useConversationAgentTabs(session: string) {
  const tabs = useBrowserState(state => state.tabs);
  const family = useConversationFamily(session);
  return useMemo(() => familyAgentTabs(family, tabs).sort((a, b) =>
    priority[agentTabState(a)] - priority[agentTabState(b)] || (b.agentAt ?? 0) - (a.agentAt ?? 0)), [family, tabs]);
}
