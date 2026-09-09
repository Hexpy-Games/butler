import {
  IconButton,
  NavRow,
  ListFilter,
  Clock3,
  Activity,
  GeneralChat,
  PanelLeft,
  PencilLine,
  Search,
  Tabs,
  TabsList,
  TabsTrigger,
  Stack,
  Typo,
} from "@/butler-ds";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import styles from "./SpaceMockup.module.css";
import { SpaceFavorites } from "./SpaceFavorites";
export function SpaceSidebarHeader() {
  const active = useMock((s) => s.active);
  const view = useMock((s) => s.view);
  const open = useMock((s) => s.open);
  const setView = useMock((s) => s.setView);
  const setDialog = useMock((s) => s.setDialog);
  const toggleSidebar = useMock((s) => s.toggleSidebar);
  return (
    <Stack gap="6" className={styles.sidebarHeader}>
      <Stack gap="1">
        <Stack
          align="row"
          justify="between"
          cross="center"
          className={styles.brand}
        >
          <Typo.AppTitle>Butler</Typo.AppTitle>
          <IconButton label="사이드바 닫기" onClick={toggleSidebar}>
            <PanelLeft size={16} />
          </IconButton>
        </Stack>
        <nav className={styles.primaryActions} aria-label="대화 시작과 검색">
          <NavRow
            icon={<PencilLine />}
            label="새 대화"
            active={active === "new"}
            onClick={() => open("new")}
          />
          <NavRow
            icon={<Search />}
            label="검색"
            onClick={() => setDialog({ type: "search" })}
          />
        </nav>
      </Stack>
      <SpaceFavorites />
      <Stack gap="3">
        <Tabs
          value={view}
          onValueChange={(value) => setView(value as typeof view)}
        >
          <TabsList stretch aria-label="대화 보기">
            <TabsTrigger value="all">
              <ListFilter size={16} />
              전체보기
            </TabsTrigger>
            <TabsTrigger value="recent">
              <Clock3 size={16} />
              최신
            </TabsTrigger>
            <TabsTrigger value="running">
              <Activity size={16} />
              진행중
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {view === "all" && (
          <NavRow
            icon={<GeneralChat />}
            label="일반"
            active={active === "general"}
            onClick={() => open("general")}
          />
        )}
      </Stack>
    </Stack>
  );
}
