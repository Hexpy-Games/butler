import { useEffect, useRef } from "react";
import { notifyStatus } from "@/app/notifications";
import { agentTabState, useConversationAgentTabs } from "./useConversationAgentTabs";
import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { ActivityGlow, activityGlowTone, Globe2, IconButton } from "@/butler-ds";
import { openConversationBrowser, useBrowserState } from "./browserBridge";
import { useBrowserShellState } from "./browserShellState";

export function BrowserToggle() {
  useAppLocale();
  const session = useButlerStore((state) => state.activeChatId);
  const open = useBrowserShellState((state) => Boolean(state.conversations[session]?.open));
  const enabled = useBrowserState((state) => state.enabled);
  const agentTabs = useConversationAgentTabs(session);
  const attention = agentTabs.find(tab => agentTabState(tab) === "attention");
  const activity = attention ? "attention" : agentTabs.some(tab => agentTabState(tab) === "busy") ? "busy"
    : agentTabs.some(tab => agentTabState(tab) === "error") ? "error" : "idle";
  const previous = useRef({ session, activity });
  useEffect(() => {
    if (activity === "attention" && (previous.current.activity !== activity || previous.current.session !== session)) notifyStatus(appCopy.browser.rail.needsCheck);
    previous.current = { session, activity };
  }, [session, activity]);
  const suffix = activity === "attention" ? appCopy.browser.rail.needsCheck : activity === "busy" ? appCopy.browser.agentUsing : activity === "error" ? appCopy.browser.rail.error : "";
  if (!window.butlerBrowser) return null;
  return <ActivityGlow state={open ? "idle" : activity}><IconButton data-test-class="titlebar-browser-toggle" aria-pressed={open}
    label={open ? appCopy.browser.hide : [appCopy.browser.show, suffix].filter(Boolean).join(" · ")}
    tone={activityGlowTone(activity, open)}
    disabled={!enabled} onClick={() => {
      if (open) useBrowserShellState.getState().setOpen(session, false);
      else void openConversationBrowser(session, (attention ?? agentTabs.find(tab => agentTabState(tab) === "busy"))?.id);
    }}><Globe2 size="md" /></IconButton></ActivityGlow>;
}
