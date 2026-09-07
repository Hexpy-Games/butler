import {
  Button,
  ButtonContainer,
  NavRow,
  NavSectionHeading,
  PencilLine,
  Search,
  Stack,
  Typo,
} from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { useOrganization } from "@/app/space/organization";
import type { SpaceRowData } from "@/app/space/projection";
import { SpaceRow } from "./SpaceRow";
import { SpaceBrand } from "./SpaceBrand";
import styles from "./SpaceSidebar.module.css";

/** These entry actions and shortcuts scroll away before the browse tabs stick. */
export function SpaceHeader({ rows }: { rows: Map<string, SpaceRowData> }) {
  const setDialog = useOrganization((s) => s.setDialog);
  const active = useButlerStore((s) => s.activeChatId);
  const favorites = [...rows.values()].filter((r) => r.pinned);
  return (
    <Stack gap="6" className={styles.sidebarHeader}>
      <Stack gap="1">
        {window.butlerApp && <SpaceBrand />}
        <nav className={styles.primaryActions} aria-label="대화 시작과 검색">
          <NavRow
            icon={<PencilLine />}
            label="새 대화"
            active={active === "draft:chat"}
            onClick={() => useButlerStore.getState().openNewChat()}
          />
          <NavRow
            icon={<Search />}
            label="검색"
            onClick={() => useButlerStore.getState().setCommandOpen(true)}
          />
        </nav>
      </Stack>
      <Stack gap="2">
        <NavSectionHeading title="즐겨찾기" />
        <Stack gap="1">
          {favorites.slice(0, 2).map((row) => (
            <SpaceRow key={row.node.key} rowKey={row.node.key} shortcut />
          ))}
          {!favorites.length && (
            <Typo.Caption className={styles.emptyFavorites}>
              자주 찾는 대화를 고정해 보세요.
            </Typo.Caption>
          )}
          {favorites.length > 2 && (
            <ButtonContainer size="sm">
              <Button
                size="sm"
                variant="inline"
                onClick={() => setDialog({ kind: "favorites" })}
              >
                즐겨찾기 모두 보기
              </Button>
            </ButtonContainer>
          )}
        </Stack>
      </Stack>
    </Stack>
  );
}
