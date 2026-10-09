import { appCopy } from "@/app/copy";
import { Button, ButtonContainer, PageBand, Popup } from "@/butler-ds";
import { browserCall, type BrowserTab } from "./browserBridge";

export function BrowserPopupBand({ tab }: { tab: BrowserTab }) {
  const copy = appCopy.browser;
  if (tab.blockedPopup) return <PageBand tone="info" icon={<Popup />} label={copy.popupBlocked}
    actions={tab.blockedPopup.reason === "no_gesture" && <ButtonContainer size="xs"><Button size="xs" variant="ghost"
      onClick={() => void browserCall("popup.allow", { id: tab.id })}>{copy.allow}</Button></ButtonContainer>} />;
  if (!tab.popup) return null;
  let host = "";
  try { host = new URL(tab.popup.url).host; } catch { /* An inherited blank popup has no displayed origin yet. */ }
  return <PageBand tone="info" icon={<Popup />} label={copy.popupOpened} detail={host}
    actions={<ButtonContainer size="xs"><Button size="xs" variant="ghost"
      onClick={() => void browserCall("popup.show", { id: tab.popup!.id })}>{copy.showPopup}</Button></ButtonContainer>} />;
}
