import type { TabRailTab } from "@/butler-ds";
import { appCopy } from "@/app/copy";
import { browserCall, openConversationBrowser, type BrowserTab } from "./browserBridge";
import { agentTabState } from "./useConversationAgentTabs";

/** The shelf chip's site name. An address without one (an IP or localhost, as Butler's own previews) shows the title. */
function siteTitle(url: string, fallback: string) {
  try {
    const host = new URL(url).hostname.replace(/^www\./u, "");
    return !host || host === "localhost" || /^[\d.]+$|^\[.*\]$/u.test(host) ? fallback : host;
  } catch { return fallback; }
}

/** Shared actions and labels for a conversation's live browser cards. */
export function agentTabCardProps(session: string, tab: BrowserTab, frame?: ImageBitmap): TabRailTab {
  const copy = appCopy.browser;
  const state = agentTabState(tab);
  const onOpen = () => void openConversationBrowser(session, tab.id);
  return { id: tab.id, title: tab.title || copy.newTab, shortTitle: siteTitle(tab.url, tab.title || copy.newTab),
    favicon: tab.favicon, frame, state,
    stateLabel: state === "attention" ? copy.rail.needsCheck : state === "busy" ? copy.agentUsing : state === "held" ? copy.userControl : copy.rail.error,
    onOpen, onClose: () => void browserCall("close", { id: tab.id }),
    needsYou: { action: { label: copy.rail.openToCheck, onAction: onOpen } },
    failure: { label: copy.rail.pageError, action: { label: copy.reload, onAction: () => void browserCall("reload", { id: tab.id }) } } };
}
