import { useState } from "react";
import { SidebarItem } from "@/components/layout/SidebarItem.tsx";
import { SidebarSessionActions } from "@/components/layout/SidebarSessionActions.tsx";
import { relativeAge } from "@/app/utils.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SessionSummary } from "@/app/types.ts";

interface ChatItemProps {
  chat: SessionSummary;
}

export function SidebarChatItem({
  chat,
}: ChatItemProps) {
  const active = useButlerStore(
    (state) => state.view.kind === "session" && state.activeChatId === chat.id,
  );
  const openSession = useButlerStore((state) => state.openSession);
  const runSessionAction = useButlerStore((state) => state.runSessionAction);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <SidebarItem
      active={active}
      badge={<span>{relativeAge(chat.last_activity_at)}</span>}
      className="chat-row"
      right={
        <SidebarSessionActions
          menuOpen={menuOpen}
          session={chat}
          setMenuOpen={setMenuOpen}
          onRunAction={runSessionAction}
        />
      }
      rightVisibility="hover"
      title={chat.title}
      onClick={() => openSession(chat.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    />
  );
}
