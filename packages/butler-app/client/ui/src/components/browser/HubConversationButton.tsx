import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { activeChatFromNavigation } from "@/app/utils";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, MessageSquare, MessageSquarePlus } from "@/butler-ds";
import { browserCall, openConversationBrowser, useBrowserState } from "./browserBridge";

export function HubConversationButton() {
  useAppLocale();
  const navigation = useButlerStore((state) => state.navigation);
  const tab = useBrowserState((state) => state.tabs.find((item) => item.id === state.activeId));
  const owner = tab?.owner.startsWith("conversation:") ? tab.owner.slice(13) : undefined;
  if (owner) return <Button size="xs" variant="ghost" iconStart={<MessageSquare size="sm" />}
    onClick={() => void openConversationBrowser(owner, tab?.id)}>
    {activeChatFromNavigation(navigation, owner).shortTitle}
  </Button>;
  const sessions = [...navigation.chats, ...navigation.projects.flatMap((project) => project.sessions ?? [])];
  const move = async (session: string) => {
    if (!tab) return;
    await browserCall("move", { tabId: tab.id, toGroupId: `conversation:${session}`, index: 0 });
    await openConversationBrowser(session, tab.id);
  };
  return <DropdownMenu><DropdownMenuTrigger asChild>
    <Button size="xs" variant="ghost" disabled={!tab} iconStart={<MessageSquarePlus size="sm" />}>
      {appCopy.browser.moveToConversation}
    </Button>
  </DropdownMenuTrigger><DropdownMenuContent align="start">
    {sessions.map((session) => <DropdownMenuItem key={session.id} onSelect={() => void move(session.id)}>
      <MessageSquare size="sm" />{activeChatFromNavigation(navigation, session.id).shortTitle}
    </DropdownMenuItem>)}
  </DropdownMenuContent></DropdownMenu>;
}
