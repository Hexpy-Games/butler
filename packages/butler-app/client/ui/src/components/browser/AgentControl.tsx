import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { ButlerThinkingMark, Button, ButtonContainer, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem, MoreHorizontal, Square, Stack, Typo } from "@/butler-ds";
import { browserCall, type BrowserTab } from "./browserBridge";

export function AgentControl({ tab }: { tab?: BrowserTab }) {
  if (!tab || tab.owner === "mine") return null;
  const copy = appCopy.browser;
  if (tab.profile === "signed_in") return <Typo.Caption>{copy.signedIn}</Typo.Caption>;
  const human = tab.holder === "user";
  return <Stack align="row" cross="center" gap="sm" shrink={false} aria-live="polite" data-test-class="browser-agent-control">
    {(human || tab.waiting || tab.inUse) && <Stack align="row" cross="center" gap="xs" data-test-class="browser-agent-use">
      <ButlerThinkingMark size="sm" state={!human && !tab.waiting ? "working" : "idle"} />
      <Typo.Caption tone="secondary" wrap="nowrap">{human ? copy.userControl : tab.waiting ? copy.waiting : copy.agentControl}</Typo.Caption>
    </Stack>}
    <ButtonContainer size="xs">
      <Button size="xs" variant="outline" onClick={() => void browserCall("control", { id: tab.id, holder: human ? "agent" : "user", sticky: true })}>{human ? copy.handBack : copy.takeOver}</Button>
      {!human && (tab.waiting || tab.inUse) && <Button size="xs" variant="outline" onClick={() => void useButlerStore.getState().cancelActiveTurn()} iconStart={<Square size="sm" />}>{copy.stop}</Button>}
      <DropdownMenu><DropdownMenuTrigger asChild><Button size="xs" variant="outline" aria-label={copy.stills}><MoreHorizontal size="sm" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end"><DropdownMenuCheckboxItem checked={tab.stills !== false} onCheckedChange={(value) => void browserCall("stills", { id: tab.id, value })}>{copy.stills}</DropdownMenuCheckboxItem></DropdownMenuContent>
      </DropdownMenu>
    </ButtonContainer>
  </Stack>;
}
