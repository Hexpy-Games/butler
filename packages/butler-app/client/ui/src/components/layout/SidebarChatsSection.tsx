import { Collapse, Expand, MessageSquarePlus } from "@/butler-ds";
import { Button, ButtonContainer, IconButton } from "@/butler-ds";
import { SidebarSection } from "@/components/layout/SidebarSection.tsx";
import { SidebarChatItem } from "@/components/layout/SidebarChatItem.tsx";
import { useSidebarSessionPaging } from "@/components/layout/useSidebarSessionPaging.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";

export function SidebarChatsSection() {
  const chatsCollapsed = useButlerStore((state) => state.sidebarChatsCollapsed);
  const setChatsCollapsed = useButlerStore(
    (state) => state.setSidebarChatsCollapsed,
  );
  const navigation = useButlerStore((state) => state.navigation);
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const openNewChat = useButlerStore((state) => state.openNewChat);
  const sidebarCopy = appCopy.sidebar;
  const chats = navigation.chats ?? [];
  const paging = useSidebarSessionPaging(chats, activeChatId);

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
      {paging.visibleSessions.map((chat) => (
        <SidebarChatItem chat={chat} key={chat.id} />
      ))}
      {paging.remainingCount > 0 ? (
        <Button
          data-test-class="sidebar-load-more"
          onClick={paging.showMore}
          size="sm"
          stretch
          text={`${appCopy.common.more} (${paging.remainingCount})`}
          type="button"
          variant="ghost"
        />
      ) : null}
    </SidebarSection>
  );
}
