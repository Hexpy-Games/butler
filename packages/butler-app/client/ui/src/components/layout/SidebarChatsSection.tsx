import { Collapse, Expand, MessageSquarePlus } from "@/butler-ds";
import { ButtonContainer, IconButton } from "@/butler-ds";
import { SidebarSection } from "@/components/layout/SidebarSection.tsx";
import { SidebarChatItem } from "@/components/layout/SidebarChatItem.tsx";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";

export function SidebarChatsSection() {
  const chatsCollapsed = useButlerStore((state) => state.sidebarChatsCollapsed);
  const setChatsCollapsed = useButlerStore(
    (state) => state.setSidebarChatsCollapsed,
  );
  const navigation = useButlerStore((state) => state.navigation);
  const openNewChat = useButlerStore((state) => state.openNewChat);
  const sidebarCopy = appCopy.sidebar;
  const chats = navigation.chats ?? [];

  return (
    <SidebarSection
      title={sidebarCopy.chats}
      collapsed={chatsCollapsed}
      actions={
        <ButtonContainer size="icon-sm">
          <IconButton
            key="collapse"
            label={
              chatsCollapsed
                ? sidebarCopy.expandChats
                : sidebarCopy.collapseChats
            }
            onClick={() => setChatsCollapsed((value) => !value)}
          >
            {chatsCollapsed ? <Expand size={15} /> : <Collapse size={15} />}
          </IconButton>
          <IconButton
            key="new"
            label={sidebarCopy.newChat}
            onClick={openNewChat}
          >
            <MessageSquarePlus size={15} />
          </IconButton>
        </ButtonContainer>
      }
    >
      {chats.map((chat) => (
        <SidebarChatItem chat={chat} key={chat.id} />
      ))}
    </SidebarSection>
  );
}
