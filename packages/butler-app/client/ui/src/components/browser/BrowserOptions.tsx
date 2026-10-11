import { appCopy } from "@/app/copy";
import { ButtonContainer, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem, IconButton, MoreHorizontal, Typo } from "@/butler-ds";
import { browserCall, type BrowserTab } from "./browserBridge";

/** Keep the existing still preference in the toolbar when control moves onto the card. */
export function BrowserOptions({ tab }: { tab?: BrowserTab }) {
  if (!tab || tab.owner === "mine") return null;
  if (tab.profile === "signed_in") return <Typo.Caption>{appCopy.browser.signedIn}</Typo.Caption>;
  return <ButtonContainer size="icon-sm"><DropdownMenu><DropdownMenuTrigger asChild>
    <IconButton label={appCopy.browser.stills}><MoreHorizontal size="sm" /></IconButton>
  </DropdownMenuTrigger><DropdownMenuContent align="end">
    <DropdownMenuCheckboxItem checked={tab.stills !== false} onCheckedChange={(value) => void browserCall("stills", { id: tab.id, value })}>{appCopy.browser.stills}</DropdownMenuCheckboxItem>
  </DropdownMenuContent></DropdownMenu></ButtonContainer>;
}
