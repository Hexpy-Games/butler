import { Settings } from "@/butler-ds";
import { SidebarItem } from "@/components/layout/SidebarItem.tsx";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";

export function SidebarSettingsItem() {
  const active = useButlerStore((state) => state.view.kind === "settings");
  const openSettings = useButlerStore((state) => state.openSettings);
  return (
    <SidebarItem
      active={active}
      icon={<Settings />}
      title={appCopy.sidebar.settings}
      onClick={() => openSettings("general")}
    />
  );
}
