import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { Button, ButtonContainer, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem, MoreHorizontal, Stack, Typo } from "@/butler-ds";
import { browserCall, type BrowserTab } from "./browserBridge";

export function AgentControl({ tab }: { tab?: BrowserTab }) {
  if (!tab || tab.owner === "mine") return null;
  const copy = appCopy.browser;
  if (tab.profile === "signed_in") return <Typo.Caption>{copy.signedIn}</Typo.Caption>;
  const human = tab.holder === "user";
  return <Stack align="row" cross="center" gap="sm" data-test-class="browser-agent-control">
    <Typo.Caption>{human ? copy.userControl : tab.waiting ? copy.waiting : copy.agentControl}</Typo.Caption>
    <ButtonContainer size="sm">
      <Button size="sm" variant="ghost" onClick={() => void browserCall("control", { id: tab.id, holder: human ? "agent" : "user", sticky: true })}>{human ? copy.handBack : copy.takeOver}</Button>
      {!human && <Button size="sm" variant="ghost" onClick={() => void useButlerStore.getState().cancelActiveTurn()}>{copy.stop}</Button>}
      <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="ghost" aria-label={copy.stills}><MoreHorizontal size="sm" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end"><DropdownMenuCheckboxItem checked={tab.stills !== false} onCheckedChange={(value) => void browserCall("stills", { id: tab.id, value })}>{copy.stills}</DropdownMenuCheckboxItem></DropdownMenuContent>
      </DropdownMenu>
    </ButtonContainer>
  </Stack>;
}
