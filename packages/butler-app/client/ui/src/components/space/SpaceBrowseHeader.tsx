import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import {
  Activity,
  ButtonContainer,
  Clock3,
  IconButton,
  ListFilter,
  NavSectionHeading,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconSlot,
  Plus,
  Stack,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { useOrganization } from "@/app/space/organization";
import { SpaceRow } from "./SpaceRow";

/** One sticky browse region; its measured height offsets nested tree headers. */
export function SpaceBrowseHeader() {
  useAppLocale();
  const tab = useOrganization((s) => s.tab);
  const setTab = useOrganization((s) => s.setTab);
  const setDialog = useOrganization((s) => s.setDialog);
  const archiveCount = useButlerStore(s => s.navigation.archive_count ?? 0);
  const hasGeneral = useButlerStore((s) =>
    s.navigation.chats.some((c) => c.id === "general"),
  );
  return (
    <Stack gap={tab === "all" ? "sm" : "lg"} compactGap="lg">
      <Stack gap="md">
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={appCopy.space.menu}>
                  <IconSlot size="sm"><Plus /></IconSlot>
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={8}>
                <DropdownMenuItem onSelect={() => setDialog({ kind: "create", parentKey: null })}>
                  {appCopy.space.newGroup}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => useButlerStore.getState().setProjectCreateDialogOpen(true)}>
                  {appCopy.space.newProject}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => useButlerStore.getState().openSettings("archive")}>
                  {archiveCount ? appCopy.clearChat.archiveCount(archiveCount) : appCopy.space.archives}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

          </ButtonContainer>
        }
      />
    </Stack>
  );
}
