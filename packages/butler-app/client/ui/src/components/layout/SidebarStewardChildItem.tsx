import { GitBranch } from "@/butler-ds";
import type { SessionSummary } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { relativeAge } from "@/app/utils.ts";
import { SidebarItem } from "./SidebarItem.tsx";

export function SidebarStewardChildItem({
  session,
}: {
  session: SessionSummary;
}) {
  const openSessionObserver = useButlerStore(
    (state) => state.openSessionObserver,
  );
  return (
    <SidebarItem
      active={false}
      ariaLabel={session.title}
      badge={<span>{relativeAge(session.last_activity_at)}</span>}
      className="steward-child-row"
      dataTestClass="sidebar-steward-child"
      icon={<GitBranch size={14} />}
      title={session.title}
      onClick={() => openSessionObserver(session.id)}
    />
  );
}
