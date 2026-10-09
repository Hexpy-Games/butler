import { appCopy } from "@/app/copy";
import { stopBrowserTurn } from "./stopBrowserTurn";
import { ButlerThinkingMark, Button, ButtonContainer, PageBand, Pick, Square, type PageCardHolder } from "@/butler-ds";
import { browserCall, type BrowserTab } from "./browserBridge";

export function browserHolder(tab?: BrowserTab): PageCardHolder {
  if (!tab || tab.owner === "mine" || !tab.url || tab.profile === "signed_in") return "none";
  if (tab.waiting) return "waiting";
  if (tab.holder === "user") return "user";
  return tab.inUse || tab.busy ? "butler" : "none";
}

export function AgentControl({ tab }: { tab?: BrowserTab }) {
  if (tab?.picking) return <PageBand tone="pick" icon={<Pick size="sm" />} label={appCopy.browser.pickMode}
    detail={appCopy.browser.dragToChat} actions={<Button size="xs" variant="outline" onClick={() => void browserCall("pick", { id: tab.id, value: false })}>{appCopy.browser.finish}</Button>} />;
  const holder = browserHolder(tab);
  if (!tab || holder === "none") return null;
  const copy = appCopy.browser;
  const human = tab.holder === "user";
  return <PageBand data-test-class="browser-agent-control" tone={tab.waiting ? "waiting" : human ? "user" : "agent"}
    icon={<ButlerThinkingMark size="sm" state={!human && !tab.waiting ? "working" : "idle"} />}
    label={tab.waiting ? copy.waiting : human ? copy.userControl : copy.agentUsing}
    hint={human && !tab.sticky ? copy.autoGiveBack : undefined}
    actions={<ButtonContainer size="xs">
      <Button size="xs" variant={tab.inUse || tab.busy || tab.waiting ? "default" : "outline"}
        onClick={() => void browserCall("control", { id: tab.id, holder: human ? "agent" : "user", sticky: !human })}>
        {human ? copy.giveBack : copy.takeOver}
      </Button>
      <Button size="xs" variant="outline" onClick={() => void stopBrowserTurn(tab.owner)} iconStart={<Square size="sm" />}>{copy.stopTask}</Button>
    </ButtonContainer>} />;
}
