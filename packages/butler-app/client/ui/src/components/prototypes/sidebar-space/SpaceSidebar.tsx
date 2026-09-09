import { SpaceSidebarHeader } from "./SpaceSidebarHeader";
import { SpaceTreeHeading } from "./SpaceTreeHeading";
import { SpaceSettingsButton } from "./SpaceSettingsButton";
import {
  Button,
  ButtonContainer,
  Clock3,
  IconButton,
  Moon,
  SidebarShell,
  Stack,
  Sun,
  Typo,
} from "@/butler-ds";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import { SpaceRow } from "./SpaceRow";
import { TreeRootDrop } from "./TreeRootDrop";
import styles from "./SpaceMockup.module.css";

export function SpaceSidebar() {
  const items = useMock((s) => s.items);
  const view = useMock((s) => s.view);
  const dark = useMock((s) => s.dark);
  const toggleTheme = useMock((s) => s.toggleTheme);
  const undoItems = useMock((s) => s.undoItems);
  const undo = useMock((s) => s.undo);
  const roots =
    view === "all"
      ? items.filter((item) => !item.parent)
      : items
          .filter(
            (item) =>
              item.kind === "session" && (view !== "running" || item.status),
          )
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  return (
    <SidebarShell
      className={styles.sidebar}
      scrollFade={false}
      ariaLabel="스페이스 탐색"
      footer={
        <Stack gap="1">
          {undoItems && (
            <ButtonContainer size="sm">
              <Button size="sm" variant="inline" onClick={undo}>
                목록 변경 되돌리기
              </Button>
            </ButtonContainer>
          )}
          <SpaceSettingsButton />
        </Stack>
      }
      header={
        <Stack gap={view === "all" ? "2" : "4"} className={styles.browseHeader}>
          <SpaceSidebarHeader />
          <SpaceTreeHeading />
        </Stack>
      }
    >
      <Stack gap="1" as="nav" aria-label="대화 목록">
        {roots.map((item) => (
          <SpaceRow key={item.id} id={item.id} flat={view !== "all"} />
        ))}
        {view === "all" && <TreeRootDrop />}
        {view === "running" && (
          <Typo.Caption className={styles.muted}>
            <Clock3 size={14} /> 확인이 필요한 대화도 포함합니다.
          </Typo.Caption>
        )}
      </Stack>
      <Stack
        align="row"
        justify="between"
        cross="center"
        className={styles.sidebarMeta}
      >
        <Typo.Caption className={styles.muted}>
          UI 목업 · 샘플 데이터
        </Typo.Caption>
        <IconButton
          label={dark ? "밝은 테마" : "어두운 테마"}
          onClick={toggleTheme}
        >
          {dark ? <Sun /> : <Moon />}
        </IconButton>
      </Stack>
    </SidebarShell>
  );
}
