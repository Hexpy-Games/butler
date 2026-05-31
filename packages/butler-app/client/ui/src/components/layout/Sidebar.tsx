import {
  Clock3,
  PencilLine,
  Search,
  SidebarNav,
  SidebarShell,
  SidebarTrafficSpace,
} from "@/butler-ds";
import { SidebarDirectItem } from "@/components/layout/SidebarDirectItem.tsx";
import { SidebarProjectsSection } from "@/components/layout/SidebarProjectsSection.tsx";
import { SidebarChatsSection } from "@/components/layout/SidebarChatsSection.tsx";
import { SidebarSettingsItem } from "@/components/layout/SidebarSettingsItem.tsx";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";

export function Sidebar() {
  const leftOpen = useButlerStore((state) => state.leftOpen);
  const sidebarCopy = appCopy.sidebar;

  return (
    <SidebarShell
      collapsed={!leftOpen}
      titlebar={<SidebarTrafficSpace />}
      header={
        <SidebarNav>
          <SidebarDirectItem
            icon={<PencilLine />}
            label="New chat"
            title={sidebarCopy.newChat}
          />
          <SidebarDirectItem
            icon={<Search />}
            label="Search"
            title={sidebarCopy.search}
          />
          <SidebarDirectItem
            icon={<Clock3 />}
            label="Automations"
            title={sidebarCopy.automations}
          />
        </SidebarNav>
      }
      footer={<SidebarSettingsItem />}
      ariaLabel={sidebarCopy.regionLabel}
    >
      <SidebarProjectsSection />
      <SidebarChatsSection />
    </SidebarShell>
  );
}
