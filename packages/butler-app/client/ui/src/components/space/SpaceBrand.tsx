import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { SidebarBrand, Typo } from "@/butler-ds";

export function SpaceBrand() {
  useAppLocale();
  return (
    <SidebarBrand>
      <Typo.AppTitle>{appCopy.firstRun.product}</Typo.AppTitle>
    </SidebarBrand>
  );
}
