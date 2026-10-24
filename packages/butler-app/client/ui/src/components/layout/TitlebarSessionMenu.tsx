import { Archive, MoreHorizontal, PencilLine, IconButton, DropdownMenu, DropdownMenuContent, DropdownMenuGroup,
  DropdownMenuItem, DropdownMenuTrigger, TITLEBAR_MENU_SIDE_OFFSET_PX } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SessionSummary } from "@/app/types.ts";
import { SessionFolderMenu } from "./SessionFolderMenu";

export function TitlebarSessionMenu({ activeSession, canOpenSessionFolder, sessionMenuOpen, setSessionMenuOpen }: {
  activeSession: SessionSummary; canOpenSessionFolder: boolean;
  sessionMenuOpen: boolean; setSessionMenuOpen: (open: boolean) => void;
}) {
  const runSessionAction = useButlerStore((state) => state.runSessionAction);
  return (
  <DropdownMenu
    open={sessionMenuOpen}
    onOpenChange={setSessionMenuOpen}
  >
    <DropdownMenuTrigger asChild>
      <IconButton
        label={appCopy.sessionActions.menuLabel}
        selected={sessionMenuOpen}
      >
        <MoreHorizontal size="md" />
      </IconButton>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      align="end"
      onInteractOutside={() => setSessionMenuOpen(false)}
      sideOffset={TITLEBAR_MENU_SIDE_OFFSET_PX}
    >
      <DropdownMenuGroup>
        <DropdownMenuItem
          onSelect={() => runSessionAction(activeSession, "rename")}
        >
          <PencilLine size="sm" /> {appCopy.sessionActions.rename}
        </DropdownMenuItem>
        <SessionFolderMenu
          disabled={!canOpenSessionFolder}
          sessionId={activeSession.id}
        />
        <DropdownMenuItem
          onSelect={() => runSessionAction(activeSession, "archive")}
        >
          <Archive size="sm" /> {appCopy.sessionActions.archive}
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
  );
}
