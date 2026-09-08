import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
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
  useAppLocale();
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
          <TabsList stretch aria-label={appCopy.space.views}>
            <TabsTrigger value="all">
              <ListFilter />
              {appCopy.space.all}</TabsTrigger>
            <TabsTrigger value="recent">
              <Clock3 />
              {appCopy.space.recent}</TabsTrigger>
            <TabsTrigger value="running">
              <Activity />
              {appCopy.space.running}</TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === "all" && hasGeneral && (
          <SpaceRow rowKey="s:general" shortcut />
        )}
      </Stack>
      <NavSectionHeading
        title={
          tab === "all" ? appCopy.space.space : tab === "recent" ? appCopy.space.recent : appCopy.space.running
        }
        actions={
          <ButtonContainer size="icon-sm">
            {tab === "all" && <IconButton
              label={appCopy.space.createGroup}
              onClick={() => setDialog({ kind: "create", parentKey: null })}
            >
              <Plus />
            </IconButton>}
            <OverflowActionMenu
              label={appCopy.space.menu}
              items={[
                {
                  label: appCopy.space.newProject,
                  onSelect: () =>
                    useButlerStore.getState().setProjectCreateDialogOpen(true),
                },
                {
                  label: appCopy.space.automations,
                  icon: <Clock3 />,
                  onSelect: () =>
                    useButlerStore.getState().setView({ kind: "automations" }),
                },
                {
                  label: appCopy.space.archives,
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
