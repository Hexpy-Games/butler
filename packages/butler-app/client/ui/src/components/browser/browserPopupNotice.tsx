import type { ReactNode } from "react";
import { appCopy } from "@/app/copy";
import { Button } from "@/butler-ds";
import { browserCall, type BrowserTab } from "./browserBridge";

/** A blocked or open pop-up, as the detail and action of the tab's one band. */
export function popupNotice(tab: BrowserTab): { label: string; detail?: string; action?: ReactNode } | null {
  const copy = appCopy.browser;
  if (tab.blockedPopup) return { label: copy.popupBlocked,
    action: tab.blockedPopup.reason === "no_gesture" ? <Button key="popup" size="xs" variant="ghost"
      onClick={() => void browserCall("popup.allow", { id: tab.id })}>{copy.allow}</Button> : undefined };
  if (!tab.popup) return null;
  let host = "";
  try { host = new URL(tab.popup.url).host; } catch { /* An inherited blank popup has no displayed origin yet. */ }
  return { label: copy.popupOpened, detail: host || undefined, action: <Button key="popup" size="xs" variant="ghost"
    onClick={() => void browserCall("popup.show", { id: tab.popup!.id })}>{copy.showPopup}</Button> };
}
