import { useMemo, useState } from "react";
import {
  Button,
  ButtonContainer,
  Clock3,
  SidebarShell,
  SidebarTrafficSpace,
  Stack,
  Typo,
} from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { useOrganization } from "@/app/space/organization";
import { projectSpace, spaceChildren } from "@/app/space/projection";
import { spaceActivity } from "@/app/space/activity";
import { SpaceHeader } from "./SpaceHeader";
import { SpaceBrowseHeader } from "./SpaceBrowseHeader";
import { SpaceRow } from "./SpaceRow";
import { SpaceDialogs } from "./SpaceDialogs";
import { SpaceRootDrop } from "./SpaceRootDrop";
import { SidebarSettingsItem } from "../layout/SidebarSettingsItem";
import styles from "./SpaceSidebar.module.css";

export function SpaceSidebar() {
  const navigation = useButlerStore((s) => s.navigation);
  const leftOpen = useButlerStore((s) => s.leftOpen);
  const tab = useOrganization((s) => s.tab);
  const error = useOrganization((s) => s.error);
  const undoToken = useOrganization((s) => s.undoToken);
  const undoRevision = useOrganization((s) => s.undoRevision);
  const smartNotice = navigation.space.smartNotice;
  const availableUndo = smartNotice?.undoToken ?? (undoRevision === navigation.space.revision ? undoToken : null);
  const pending = useOrganization((s) => s.pending);
  const revealPath = useOrganization((s) => s.revealPath);
  const rows = useMemo(() => projectSpace(navigation), [navigation]);
  const [visibleCount, setVisibleCount] = useState(30);
  const roots =
    tab === "all"
      ? spaceChildren(rows, null)
      : [...rows.values()]
          .filter(
            (r) => r.session && (tab === "recent" || spaceActivity(r.session)),
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.node.key.localeCompare(b.node.key));
  return (
    <>
      <SidebarShell
        collapsed={!leftOpen}
        titlebar={
          window.butlerApp?.platform === "darwin" ? (
            <SidebarTrafficSpace />
          ) : undefined
        }
        className={styles.sidebar}
        ariaLabel="스페이스 탐색"
        scrollHeader={<SpaceHeader rows={rows} />}
        stickyHeader={<SpaceBrowseHeader />}
        footer={
          <Stack gap="1">
            {error && <Typo.Caption role="alert">{error}</Typo.Caption>}
            {smartNotice && <Typo.Caption role="status">{smartNotice.title} 그룹으로 정리했습니다.</Typo.Caption>}
            {availableUndo && (
              <ButtonContainer size="sm">
                <Button
                  size="sm"
                  variant="inline"
                  disabled={pending}
                  onClick={() => {
                    void useOrganization
                      .getState()
                      .mutate({ action: "undo", undoToken: availableUndo });
                  }}
                >
                  목록 변경 되돌리기
                </Button>
              </ButtonContainer>
            )}
            <SidebarSettingsItem />
          </Stack>
        }
      >
        <Stack gap="1" as="nav" aria-label="대화 목록">
          {roots
            .slice(
              0,
              Math.max(
                visibleCount,
                roots.findIndex((row) => revealPath.includes(row.node.key)) + 1,
              ),
            )
            .map((row) => (
              <SpaceRow
                key={`${tab}:${row.node.key}`}
                rowKey={row.node.key}
                flat={tab !== "all"}
              />
            ))}
          {roots.length > visibleCount && (
            <ButtonContainer size="sm">
              <Button
                size="sm"
                variant="inline"
                onClick={() => setVisibleCount((n) => n + 30)}
              >
                나머지 {roots.length - visibleCount}개 더보기
              </Button>
            </ButtonContainer>
          )}
          {tab === "all" && <SpaceRootDrop rows={rows} />}
          {tab === "running" && (
            <Typo.Caption className={styles.muted}>
              <Clock3 /> 확인이 필요한 대화도 포함합니다.
            </Typo.Caption>
          )}
        </Stack>
      </SidebarShell>
      <SpaceDialogs rows={rows} />
    </>
  );
}
