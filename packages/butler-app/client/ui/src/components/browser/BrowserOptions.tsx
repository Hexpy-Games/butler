import { appCopy } from "@/app/copy";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem, DropdownMenuItem, IconButton, MoreHorizontal, Typo } from "@/butler-ds";
import { browserCall, type BrowserTab } from "./browserBridge";
import { openHistory } from "./historyApi";

/** Browser-wide commands and conversation-specific presentation. */
export function BrowserOptions({ tab }: { tab?: BrowserTab }) {
  return <>{tab?.owner !== "mine" && tab?.profile === "signed_in" && <Typo.Caption>{appCopy.browser.signedIn}</Typo.Caption>}<DropdownMenu><DropdownMenuTrigger asChild>
    <IconButton label={appCopy.browser.more}><MoreHorizontal size="sm" /></IconButton>
  </DropdownMenuTrigger><DropdownMenuContent align="end">
    <DropdownMenuItem onSelect={() => openHistory()}>{appCopy.browser.history.title}</DropdownMenuItem>
    {tab && tab.owner !== "mine" && <DropdownMenuCheckboxItem checked={tab.stills !== false}
      onCheckedChange={value => void browserCall("stills", { id: tab.id, value })}>{appCopy.browser.stills}</DropdownMenuCheckboxItem>}
  </DropdownMenuContent></DropdownMenu></>;
}
