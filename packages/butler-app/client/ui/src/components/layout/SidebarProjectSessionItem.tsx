import { useState } from "react";
import { SidebarItem } from "@/components/layout/SidebarItem.tsx";
import { SidebarSessionActions } from "@/components/layout/SidebarSessionActions.tsx";
import { SidebarStewardChildItem } from "@/components/layout/SidebarStewardChildItem.tsx";
import { relativeAge } from "@/app/utils.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SessionSummary } from "@/app/types.ts";
import { useLongPressAction } from "./useLongPressAction";

interface ProjectSessionItemProps {
  session: SessionSummary;
}

export function SidebarProjectSessionItem({
  session,
}: ProjectSessionItemProps) {
  const active = useButlerStore(
    (state) =>
      state.view.kind === "session" && state.activeChatId === session.id,
  );
  const openSession = useButlerStore((state) => state.openSession);
  const runSessionAction = useButlerStore((state) => state.runSessionAction);
  const [menuOpen, setMenuOpen] = useState(false);
  const longPress = useLongPressAction(() => setMenuOpen(true));

  return (
    <div
      data-test-class="project-session-gesture"
      style={{ WebkitTouchCallout: "none", userSelect: "none" }}
      {...longPress}
    >
      <SidebarItem
        active={active}
        badge={<time>{relativeAge(session.last_activity_at)}</time>}
        className="project-session-row"
        dataTestClass="project-session-row"
        right={
          <SidebarSessionActions
            menuOpen={menuOpen}
            session={session}
            setMenuOpen={setMenuOpen}
            onRunAction={runSessionAction}
          />
        }
        rightVisibility="hover-compact-hidden"
        title={session.title}
        onClick={() => openSession(session.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuOpen(true);
        }}
      />
      {session.steward_children?.length ? (
        <div
          aria-label={session.title}
          data-test-class="sidebar-steward-children"
          role="group"
        >
          {session.steward_children.map((child) => (
            <SidebarStewardChildItem key={child.id} session={child} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
