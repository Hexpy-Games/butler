import { useEffect } from "react";
import {
  Button,
  ButtonContainer,
  ChromeFloatingToggleLayer,
  IconButton,
  PanelLeft,
  Stack,
  TitlebarShell,
  Typo,
} from "@/butler-ds";
import { SpaceComposer } from "./SpaceComposer";
import { SpaceConversation } from "./SpaceConversation";
import { SpaceDialogs } from "./SpaceDialogs";
import { SpaceSidebar } from "./SpaceSidebar";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import { locationOf } from "@/app/prototypes/sidebar-space/sample-data";
import styles from "./SpaceMockup.module.css";

export function SpaceMockup() {
  const active = useMock((s) => s.active);
  const items = useMock((s) => s.items);
  const dark = useMock((s) => s.dark);
  const sidebarOpen = useMock((s) => s.sidebarOpen);
  const toggleSidebar = useMock((s) => s.toggleSidebar);
  const notice = useMock((s) => s.notice);
  const undoItems = useMock((s) => s.undoItems);
  const undo = useMock((s) => s.undo);
  const item = items.find((row) => row.id === active);
  useEffect(() => {
    document.body.classList.toggle("theme-dark", dark);
    document.body.classList.toggle("theme-light", !dark);
  }, [dark]);
  return (
    <div className={styles.app} data-sidebar-open={sidebarOpen}>
      {sidebarOpen && <SpaceSidebar />}
      {!sidebarOpen && (
        <ChromeFloatingToggleLayer>
          <IconButton label="사이드바 열기" onClick={toggleSidebar}>
            <PanelLeft size={18} />
          </IconButton>
        </ChromeFloatingToggleLayer>
      )}
      <main className={styles.main}>
        <TitlebarShell
          collapsed={!sidebarOpen}
          title={
            active === "general"
              ? "#일반"
              : active === "new"
                ? "새 대화"
                : (item?.title ?? "대화")
          }
          subtitle={item ? locationOf(item, items) : undefined}
          trailing={
            <Typo.Caption className={styles.muted}>UI 목업</Typo.Caption>
          }
        />
        <SpaceConversation key={active} />
        {notice && (
          <Stack
            align="row"
            cross="center"
            justify="between"
            className={styles.notice}
            role="status"
          >
            <Typo.Caption>{notice}</Typo.Caption>
            {undoItems && (
              <ButtonContainer size="sm">
                <Button size="sm" variant="inline" onClick={undo}>
                  되돌리기
                </Button>
              </ButtonContainer>
            )}
          </Stack>
        )}
        <SpaceComposer />
      </main>
      <SpaceDialogs />
    </div>
  );
}
