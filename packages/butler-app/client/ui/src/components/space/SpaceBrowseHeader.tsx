import {
  Activity,
  ButtonContainer,
  Clock3,
  IconButton,
  ListFilter,
  NavSectionHeading,
  OverflowActionMenu,
  Plus,
  Stack,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { useOrganization } from "@/app/space/organization";
import { SpaceRow } from "./SpaceRow";
import styles from "./SpaceSidebar.module.css";

/** One sticky browse region; its measured height offsets nested tree headers. */
export function SpaceBrowseHeader() {
  const tab = useOrganization((s) => s.tab);
  const setTab = useOrganization((s) => s.setTab);
  const setDialog = useOrganization((s) => s.setDialog);
  const hasGeneral = useButlerStore((s) =>
    s.navigation.chats.some((c) => c.id === "general"),
  );
  return (
    <Stack gap={tab === "all" ? "2" : "4"} className={styles.browseHeader}>
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
        {tab === "all" && hasGeneral && (
          <SpaceRow rowKey="s:general" shortcut />
        )}
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
