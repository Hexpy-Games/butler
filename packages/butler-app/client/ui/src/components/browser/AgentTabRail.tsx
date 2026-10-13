import { useLayoutEffect, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { TabRail, tabRailCap, tabRailMode } from "@/butler-ds";
import { browserCall, openConversationBrowser } from "./browserBridge";
import { agentTabState, useConversationAgentTabs } from "./useConversationAgentTabs";
import { useDocumentVisible, useLiveFrames } from "./useLiveFrames";

/** Stream only the cards DS will show, measured from the conversation, not the window. */
export function AgentTabRail({ session }: { session: string }) {
  useAppLocale();
  const tabs = useConversationAgentTabs(session);
  const visible = useDocumentVisible();
  const [box, setBox] = useState<{ width: number; height: number }>();
  useLayoutEffect(() => {
    const shell = document.querySelector<HTMLElement>('[data-test-class="conversation"]');
    if (!shell) return;
    const update = () => setBox({ width: shell.clientWidth, height: shell.clientHeight });
    update();
    const observer = new ResizeObserver(update); observer.observe(shell);
    return () => observer.disconnect();
  }, [session]);
  const cap = box ? tabRailCap(box.height) : 0;
  const mode = box ? tabRailMode(box.width) : "full";
  const frames = useLiveFrames(visible ? tabs.slice(0, cap).map(tab => tab.id) : [], mode === "full" ? 416 : mode === "compact" ? 256 : 96);
  const copy = appCopy.browser;
  return <TabRail view={session} labels={{ region: copy.rail.region, close: copy.closeTab, more: copy.rail.more }}
    onMore={id => void openConversationBrowser(session, id)} tabs={tabs.map(tab => {
      const state = agentTabState(tab);
      const onOpen = () => void openConversationBrowser(session, tab.id);
      return { id: tab.id, title: tab.title || copy.newTab, favicon: tab.favicon, frame: frames[tab.id], state,
        stateLabel: state === "attention" ? copy.rail.needsCheck : state === "busy" ? copy.agentUsing : state === "held" ? copy.userControl : copy.rail.error,
        onOpen, onClose: () => void browserCall("close", { id: tab.id }),
        needsYou: { action: { label: copy.rail.openToCheck, onAction: onOpen } },
        failure: { label: copy.rail.pageError, action: { label: copy.reload, onAction: () => void browserCall("reload", { id: tab.id }) } } };
    })} />;
}
