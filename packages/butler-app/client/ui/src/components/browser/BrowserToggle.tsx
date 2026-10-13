import { useMemo } from "react";
import { conversationAgentTabs } from "./conversationAgentTabs";
import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { Globe2, IconButton } from "@/butler-ds";
import { openConversationBrowser, useBrowserState } from "./browserBridge";
import { useBrowserShellState } from "./browserShellState";

export function BrowserToggle() {
  useAppLocale();
  const session = useButlerStore((state) => state.activeChatId);
  const open = useBrowserShellState((state) => Boolean(state.conversations[session]?.open));
  const enabled = useBrowserState((state) => state.enabled);
  const tabs = useBrowserState((state) => state.tabs);
  const views = useButlerStore((state) => state.sessionViews);
  const agentTabs = useMemo(() => conversationAgentTabs(session, tabs, views), [session, tabs, views]);
  const browsing = agentTabs.some((tab) => tab.busy || tab.inUse);
  // Butler's tabs never become active on their own, so the globe opens the one it is using.
  const target = agentTabs.find((tab) => tab.waiting || tab.signinStep || tab.payStep || tab.dialog)
    ?? agentTabs.filter((tab) => tab.busy || tab.inUse).at(-1);
  if (!window.butlerBrowser) return null;
  return <IconButton data-test-class="titlebar-browser-toggle" aria-pressed={open}
    label={open ? appCopy.browser.hide : appCopy.browser.show}
    tone={browsing ? "riso" : open ? "butler" : "default"} indicator={browsing && !open}
    disabled={!enabled} onClick={() => {
      if (open) useBrowserShellState.getState().setOpen(session, false);
      else void openConversationBrowser(session, target?.id);
    }}><Globe2 size="md" /></IconButton>;
}
