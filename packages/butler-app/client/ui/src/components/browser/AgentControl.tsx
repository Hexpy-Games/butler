import { appCopy } from "@/app/copy";
import { stopBrowserTurn } from "./stopBrowserTurn";
import { ButlerThinkingMark, Button, ButtonContainer, PageBand, Pick, Popup, Square, type PageCardHolder } from "@/butler-ds";
import { browserCall, type BrowserTab } from "./browserBridge";
import { popupNotice } from "./browserPopupNotice";

/** Tabs Butler can hold show the idle line in the reserved row; your tabs and signed-in tabs leave it empty. */
export function browserHoldable(tab?: BrowserTab) {
  return Boolean(tab && tab.owner !== "mine" && tab.profile !== "signed_in");
}

export function browserHolder(tab?: BrowserTab): PageCardHolder {
  if (!tab || !browserHoldable(tab) || !tab.url) return "none";
  if (tab.waiting) return "waiting";
  if (tab.holder === "user") return "user";
  return tab.inUse || tab.busy ? "butler" : "none";
}

/** The tab's one band: pick mode, the holder, a pop-up, or the idle line on Butler's tabs. A second state joins as the detail. */
export function AgentControl({ tab }: { tab?: BrowserTab }) {
  const copy = appCopy.browser;
  const popup = tab ? popupNotice(tab) : null;
  const popupText = popup && (popup.detail ? `${popup.label} · ${popup.detail}` : popup.label);
  if (tab?.picking) return <PageBand tone="pick" icon={<Pick size="sm" />} label={copy.pickMode}
    detail={popupText ?? copy.dragToChat} hint={popupText ? copy.dragToChat : undefined}
    actions={<ButtonContainer size="xs">{popup?.action}<Button size="xs" variant="outline"
      onClick={() => void browserCall("pick", { id: tab.id, value: false })}>{copy.finish}</Button></ButtonContainer>} />;
  const holder = browserHolder(tab);
  if (tab && holder !== "none") {
    const human = tab.holder === "user";
    return <PageBand data-test-class="browser-agent-control" tone={tab.waiting ? "waiting" : human ? "user" : "agent"}
      icon={<ButlerThinkingMark size="sm" state={!human && !tab.waiting ? "working" : "idle"} />}
      label={tab.waiting ? copy.waiting : human ? copy.userControl : copy.agentUsing} detail={popupText ?? undefined}
      hint={human && !tab.sticky ? copy.autoGiveBack : undefined}
      actions={<ButtonContainer size="xs">
        {popup?.action}
        <Button size="xs" variant={tab.inUse || tab.busy || tab.waiting ? "default" : "outline"}
          onClick={() => void browserCall("control", { id: tab.id, holder: human ? "agent" : "user", sticky: !human })}>
          {human ? copy.giveBack : copy.takeOver}
        </Button>
        <Button size="xs" variant="outline" onClick={() => void stopBrowserTurn(tab.owner)} iconStart={<Square size="sm" />}>{copy.stopTask}</Button>
      </ButtonContainer>} />;
  }
  if (popup) return <PageBand tone="info" icon={<Popup />} label={popup.label} detail={popup.detail}
    actions={popup.action && <ButtonContainer size="xs">{popup.action}</ButtonContainer>} />;
  if (!browserHoldable(tab)) return null;
  return <PageBand data-test-class="browser-idle-band" tone="idle" icon={<ButlerThinkingMark size="sm" />} label={copy.butlerTab} />;
}
