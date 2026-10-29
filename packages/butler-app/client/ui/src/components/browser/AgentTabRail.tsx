import { canOpenHandoffTab } from "./browserHandoff";
import { useLayoutEffect, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { TabRail, tabRailCap, tabRailMode } from "@/butler-ds";
import { openConversationBrowser } from "./browserBridge";
import { useConversationAgentTabs } from "./useConversationAgentTabs";
import { agentTabCardProps } from "./agentTabCardProps";
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
  const frames = useLiveFrames(tabs.slice(0, cap).map(tab => tab.id), mode === "full" ? 416 : mode === "compact" ? 256 : 96, !visible);
  if (!canOpenHandoffTab()) return null;
  const copy = appCopy.browser;
  return <TabRail view={session} labels={{ region: copy.rail.region, close: copy.closeTab, more: copy.rail.more }}
    onMore={id => void openConversationBrowser(session, id)} tabs={tabs.map(tab => agentTabCardProps(session, tab, frames[tab.id]))} />;
}
