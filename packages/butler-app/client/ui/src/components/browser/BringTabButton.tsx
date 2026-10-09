import { appCopy } from "@/app/copy";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, TabIn } from "@/butler-ds";
import { browserCall, useBrowserState } from "./browserBridge";

export function BringTabButton({ sessionId }: { sessionId: string }) {
  const tabs = useBrowserState((state) => state.tabs).filter((tab) => tab.owner === "mine");
  const bring = async (id: string) => {
    const moved = await browserCall("move", { tabId: id, toGroupId: `conversation:${sessionId}`, index: 0 });
    if (moved === id) await browserCall("activate", { id });
  };
  return <DropdownMenu><DropdownMenuTrigger asChild>
    <Button size="xs" variant="ghost" disabled={!tabs.length} iconStart={<TabIn size="sm" />}>{appCopy.browser.bringTab}</Button>
  </DropdownMenuTrigger><DropdownMenuContent align="end">
    {tabs.map((tab) => <DropdownMenuItem key={tab.id} onSelect={() => void bring(tab.id)}>{tab.title || appCopy.browser.newTab}</DropdownMenuItem>)}
  </DropdownMenuContent></DropdownMenu>;
}
