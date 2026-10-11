import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { activeChatFromNavigation } from "@/app/utils";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, MessageSquare, MessageSquarePlus } from "@/butler-ds";
import { api } from "@/app/api";
import { publicBrowserOwner } from "./browserOwnership";
import { browserCall, openConversationBrowser, useBrowserState } from "./browserBridge";

export function HubConversationButton() {
  useAppLocale();
  const navigation = useButlerStore((state) => state.navigation);
  const tab = useBrowserState((state) => state.tabs.find((item) => item.id === state.activeId));
  const owner = tab && publicBrowserOwner(tab.owner, navigation);
  if (owner) return <Button size="xs" variant="ghost" iconStart={<MessageSquare size="sm" />}
    onClick={() => void openConversationBrowser(owner, tab?.id)}>
    {activeChatFromNavigation(navigation, owner).shortTitle}
  </Button>;
  if (tab && tab.owner !== "mine" && !owner) return null;
  const sessions = [...navigation.chats, ...navigation.projects.flatMap((project) => project.sessions ?? [])]
    .filter((session) => !session.archived).sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
  const move = async (session: string) => {
    if (!tab) return;
    const moved = await browserCall("move", { tabId: tab.id, toGroupId: `conversation:${session}`, index: 0 });
    if (moved === tab.id) await openConversationBrowser(session, tab.id);
  };
  const create = async () => {
    const result = await api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: appCopy.browser.newConversation, workspace_mode: "local" }) });
    await useButlerStore.getState().refreshNavigation();
    await move(result.session.id);
  };
  return <DropdownMenu><DropdownMenuTrigger asChild>
    <Button size="xs" variant="ghost" disabled={!tab} iconStart={<MessageSquarePlus size="sm" />}>
      {appCopy.browser.moveToConversation}
    </Button>
  </DropdownMenuTrigger><DropdownMenuContent align="start">
    {sessions.map((session) => <DropdownMenuItem key={session.id} onSelect={() => void move(session.id)}>
      <MessageSquare size="sm" />{activeChatFromNavigation(navigation, session.id).shortTitle}
    </DropdownMenuItem>)}
    <DropdownMenuItem onSelect={() => void create()}><MessageSquarePlus size="sm" />{appCopy.browser.newConversation}</DropdownMenuItem>
  </DropdownMenuContent></DropdownMenu>;
}
