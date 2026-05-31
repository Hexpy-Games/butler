import { Clock3, PencilLine, Search } from "../../components/Icons";
import { NavRow } from "../NavRow";
import { SidebarNav, SidebarShell, SidebarTrafficSpace } from "./SidebarShell";

export function SidebarShellFixture() {
  return (
    <SidebarShell
      titlebar={<SidebarTrafficSpace />}
      footer={<NavRow icon={<Search />} label="Settings" />}
      header={
        <SidebarNav>
          <NavRow icon={<PencilLine />} label="New chat" active />
          <NavRow icon={<Search />} label="Search" />
          <NavRow icon={<Clock3 />} label="Automations" />
        </SidebarNav>
      }
      ariaLabel="Sidebar"
    >
      <NavRow label="Project session" badge="2d" />
      <NavRow label="General chat" badge="5d" />
    </SidebarShell>
  );
}
