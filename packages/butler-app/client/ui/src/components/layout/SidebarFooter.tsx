import { appCopy, useAppLocale } from "@/app/copy";
import { SidebarNav } from "@/butler-ds";
import { SidebarSettingsItem } from "./SidebarSettingsItem";
import { SidebarUpdateItem } from "./SidebarUpdateItem";

export function SidebarFooter() {
  useAppLocale();
  return <SidebarNav ariaLabel={appCopy.shell.footerNav}>
    <SidebarUpdateItem />
    <SidebarSettingsItem />
  </SidebarNav>;
}
