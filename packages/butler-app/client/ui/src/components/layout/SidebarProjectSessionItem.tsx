import { useState } from "react";
import { SidebarItem } from "@/components/layout/SidebarItem.tsx";
import { SidebarSessionActions } from "@/components/layout/SidebarSessionActions.tsx";
import { relativeAge } from "@/app/utils.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SessionSummary } from "@/app/types.ts";
import { useLongPressAction } from "./useLongPressAction";
import styles from "./SidebarProjectSessionItem.module.css";

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
      className={styles.gestureSurface}
      data-test-class="project-session-gesture"
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
    </div>
  );
}
