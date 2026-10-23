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
  FolderPlus,
  IconSlot,
  PencilLine,
  SegmentedControl,
  Stack,
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
        <SegmentedControl
          stretch
          ariaLabel={appCopy.space.views}
          value={tab}
          onValueChange={(value) => setTab(value as typeof tab)}
          options={[
            { value: "all", label: appCopy.space.all, icon: <ListFilter /> },
            { value: "recent", label: appCopy.space.recent, icon: <Clock3 /> },
            { value: "running", label: appCopy.space.running, icon: <Activity /> },
          ]}
        />
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
            <IconButton
              label={appCopy.space.newChat}
              onClick={() => useButlerStore.getState().openNewChat()}
            >
              <IconSlot size="sm"><PencilLine /></IconSlot>
            </IconButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={appCopy.space.menu}>
                  <IconSlot size="sm"><FolderPlus /></IconSlot>
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
