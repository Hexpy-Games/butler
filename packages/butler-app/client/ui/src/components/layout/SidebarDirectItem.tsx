import { SidebarItem } from "@/components/layout/SidebarItem.tsx";
import { useButlerStore } from "@/app/store.ts";
import type { IconElement } from "@/app/types.ts";

interface SidebarDirectItemProps {
  icon: IconElement;
  label: "New chat" | "Search" | "Automations";
  title: string;
}

export function SidebarDirectItem({
  icon,
  label,
  title,
}: SidebarDirectItemProps) {
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const view = useButlerStore((state) => state.view);
  const openNewChat = useButlerStore((state) => state.openNewChat);
  const setCommandOpen = useButlerStore((state) => state.setCommandOpen);
  const setView = useButlerStore((state) => state.setView);
  const active =
    label === "New chat"
      ? activeChatId === "draft:chat" && view.kind === "session"
      : label === "Automations"
        ? view.kind === "automations" || view.kind === "automation-detail"
        : false;
  const onClick =
    label === "New chat"
      ? openNewChat
      : label === "Search"
        ? () => setCommandOpen(true)
        : () => setView({ kind: "automations" });

  return (
    <SidebarItem
      active={active}
      icon={icon}
      title={title}
      onClick={onClick}
    />
  );
}
