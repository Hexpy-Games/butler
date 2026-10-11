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
  const browsing = useBrowserState((state) => state.tabs.some((tab) => tab.owner === `conversation:${session}` && tab.busy));
  if (!window.butlerBrowser) return null;
  return <IconButton data-test-class="titlebar-browser-toggle" aria-pressed={open}
    label={open ? appCopy.browser.hide : appCopy.browser.show}
    tone={browsing ? "riso" : open ? "butler" : "default"} indicator={browsing && !open}
    disabled={!enabled} onClick={() => {
      if (open) useBrowserShellState.getState().setOpen(session, false);
      else void openConversationBrowser(session);
    }}><Globe2 size="md" /></IconButton>;
}
