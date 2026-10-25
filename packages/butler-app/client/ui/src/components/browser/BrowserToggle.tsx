import { agentTabState, useConversationAgentTabs } from "./useConversationAgentTabs";
import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { ActivityGlow, activityGlowTone, Globe2, IconButton } from "@/butler-ds";
import { openConversationBrowser, useBrowserState } from "./browserBridge";
import { useBrowserShellState } from "./browserShellState";
import { useRightSlot } from "../file-viewer/useRightSlot";

export function BrowserToggle() {
  useAppLocale();
  const session = useButlerStore((state) => state.activeChatId);
  // Pressed while the browser holds the right slot; open behind the file viewer, a press brings it forward.
  const open = useRightSlot(session) === "browser";
  const enabled = useBrowserState((state) => state.enabled);
  const agentTabs = useConversationAgentTabs(session);
  const attention = agentTabs.find(tab => agentTabState(tab) === "attention");
  const activity = attention ? "attention" : agentTabs.some(tab => agentTabState(tab) === "busy") ? "busy"
    : agentTabs.some(tab => agentTabState(tab) === "error") ? "error" : "idle";
  if (!window.butlerBrowser) return null;
  return <ActivityGlow state={open ? "idle" : activity}><IconButton data-test-class="titlebar-browser-toggle" pane="browser" pressed={open}
    label={open ? appCopy.browser.hide : activity === "idle" ? appCopy.browser.show : appCopy.browser.glow[activity]}
    tone={activityGlowTone(activity, open)}
    disabled={!enabled} onClick={() => {
      if (open) useBrowserShellState.getState().setOpen(session, false);
      else void openConversationBrowser(session, (attention ?? agentTabs.find(tab => agentTabState(tab) === "busy"))?.id);
    }}><Globe2 size="md" /></IconButton></ActivityGlow>;
}
