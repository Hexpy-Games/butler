import {
  Activity,
  Button,
  ButtonContainer,
  Clock3,
  IconButton,
  ListFilter,
  NavRow,
  NavSectionHeading,
  OverflowActionMenu,
  PanelLeft,
  PencilLine,
  Plus,
  Search,
  Stack,
  Tabs,
  TabsList,
  TabsTrigger,
  Typo,
} from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { useOrganization } from "@/app/space/organization";
import type { SpaceRowData } from "@/app/space/projection";
import { SpaceRow } from "./SpaceRow";
import styles from "./SpaceSidebar.module.css";

export function SpaceHeader({ rows }: { rows: Map<string, SpaceRowData> }) {
  const tab = useOrganization((s) => s.tab);
  const setTab = useOrganization((s) => s.setTab);
  const setDialog = useOrganization((s) => s.setDialog);
  const active = useButlerStore((s) => s.activeChatId);
  const favorites = [...rows.values()].filter((r) => r.pinned);
  const generalId = useButlerStore(
    (s) => s.navigation.chats.find((c) => c.id === "general")?.id,
  );
  return (
    <Stack gap={tab === "all" ? "2" : "4"} className={styles.browseHeader}>
      <Stack gap="6" className={styles.sidebarHeader}>
        <Stack gap="1">
          <Stack
            align="row"
            justify="between"
            cross="center"
            className={styles.brand}
          >
            <Typo.AppTitle>Butler</Typo.AppTitle>
            <IconButton
              label="사이드바 닫기"
              onClick={() => useButlerStore.getState().setLeftOpen(false)}
            >
              <PanelLeft />
            </IconButton>
          </Stack>
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
        <Stack gap="1">
          <NavSectionHeading title="즐겨찾기" />
          {favorites.slice(0, 2).map((row) => (
            <SpaceRow key={row.node.key} rowKey={row.node.key} shortcut />
          ))}
          {!favorites.length && (
            <Typo.Caption className={styles.muted}>
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
        <Stack gap="3">
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as typeof tab)}
          >
            <TabsList stretch aria-label="대화 보기">
              <TabsTrigger value="all">
                <ListFilter />
                전체보기
              </TabsTrigger>
              <TabsTrigger value="recent">
                <Clock3 />
                최신
              </TabsTrigger>
              <TabsTrigger value="running">
                <Activity />
                진행중
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {tab === "all" && generalId && (
            <SpaceRow rowKey="s:general" shortcut />
          )}
        </Stack>
      </Stack>
      <NavSectionHeading
        title={
          tab === "all" ? "스페이스" : tab === "recent" ? "최신" : "진행중"
        }
        actions={
          <ButtonContainer size="icon-sm">
            <IconButton
              label="그룹 만들기"
              onClick={() => setDialog({ kind: "create", parentKey: null })}
            >
              <Plus />
            </IconButton>
            <OverflowActionMenu
              label="스페이스 메뉴"
              items={[
                {
                  label: "새 프로젝트",
                  onSelect: () =>
                    useButlerStore.getState().setProjectCreateDialogOpen(true),
                },
                {
                  label: "예약 작업",
                  icon: <Clock3 />,
                  onSelect: () =>
                    useButlerStore.getState().setView({ kind: "automations" }),
                },
                {
                  label: "보관함",
                  onSelect: () =>
                    useButlerStore.getState().openSettings("archive"),
                },
              ]}
            />
          </ButtonContainer>
        }
      />
    </Stack>
  );
}
