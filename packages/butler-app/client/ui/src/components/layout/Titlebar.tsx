import { useAppLocale } from "@/app/copy.ts";
import { useMemo, useState } from "react";
import {
  Archive,
  ButtonContainer,
  MoreHorizontal,
  PanelRight,
  PanelRightClose,
  PencilLine,
} from "@/butler-ds";
import { IconButton } from "@/butler-ds";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
  TITLEBAR_MENU_SIDE_OFFSET_PX,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { isServerBackedSessionId } from "@/app/sessionIds.ts";
import { selectRightAvailable, useButlerStore } from "@/app/store.ts";
import {
  activeChatFromNavigation,
  activeTitleForView,
  sessionFromNavigation,
} from "@/app/utils.ts";
import type { ActiveChatView } from "@/app/types.ts";
import { TitlebarShell } from "@/butler-ds";
import { SessionFolderMenu } from "./SessionFolderMenu";
import { TitlebarWorkspaceSubtitle } from "./TitlebarWorkspaceSubtitle";
import { WindowControls } from "./WindowControls";
import { BrowserToggle } from "../browser/BrowserToggle";
import { HubConversationButton } from "../browser/HubConversationButton";


export function Titlebar({ sidebarOpen }: { sidebarOpen?: boolean }) {
  useAppLocale();
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const storeView = useButlerStore((state) => state.view);
  const storeNavigation = useButlerStore((state) => state.navigation);
  const storeActiveChatId = useButlerStore((state) => state.activeChatId);
  const storeActiveChatTitle = useButlerStore((state) => state.activeChatTitle);
  const leftOpen = useButlerStore((state) => state.leftOpen);
  const rightOpen = useButlerStore((state) => state.rightOpen);
  const rightAvailable = useButlerStore(selectRightAvailable);
  const runSessionAction = useButlerStore((state) => state.runSessionAction);
  const setRightOpen = useButlerStore((state) => state.setRightOpen);
  const { title, subtitle } = useMemo(
    () =>
      activeTitleForView(
        storeView,
        activeChatFromNavigation(
          storeNavigation,
          storeActiveChatId,
          storeActiveChatTitle,
        ) as ActiveChatView,
      ),
    [storeActiveChatId, storeActiveChatTitle, storeNavigation, storeView],
  );
  const activeSession =
    storeView.kind === "session" && isServerBackedSessionId(storeActiveChatId)
      ? sessionFromNavigation(storeNavigation, storeActiveChatId)
      : null;
  const branchInfo = useButlerStore((state) =>
    state.view.kind === "session" && state.summary?.session_id === storeActiveChatId
      ? state.summary.branch_info
      : undefined,
  );
  const hasWorkspaceIdentity = branchInfo?.workspace_binding === "session_worktree" ||
    branchInfo?.workspace_binding === "project";
  const canOpenSessionFolder = Boolean(
    hasWorkspaceIdentity && branchInfo?.workspace_status === "available",
  );

  return (
    <TitlebarShell
      title={<span data-test-class="titlebar-title">{title}</span>}
      subtitle={
        subtitle || hasWorkspaceIdentity ? (
          <TitlebarWorkspaceSubtitle
            branchInfo={branchInfo}
            projectLabel={subtitle}
          />
        ) : undefined
      }
      collapsed={!(sidebarOpen ?? leftOpen)}
      leading={storeView.kind === "browser" ? <HubConversationButton /> : undefined}
      leadingSize="auto"
      dragRegion
      dataTestClass="custom-titlebar"
      windowControls={<WindowControls />}
      trailing={
        <ButtonContainer size="icon-sm" data-test-class="project-controls">
          {activeSession ? (
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
          ) : null}
          {storeView.kind === "session" && isServerBackedSessionId(storeActiveChatId) && <BrowserToggle />}
          {rightAvailable && (
            <IconButton
              data-test-class="titlebar-right-panel-toggle"
              label={
                rightOpen
                  ? appCopy.titlebar.hideRightPanel
                  : appCopy.titlebar.showRightPanel
              }
              onClick={() => setRightOpen((value) => !value)}
            >
              {rightOpen ? (
                <PanelRightClose size="md" />
              ) : (
                <PanelRight size="md" />
              )}
            </IconButton>
          )}
        </ButtonContainer>
      }
    />
  );
}
