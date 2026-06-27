import { useMemo, useState } from "react";
import {
  Archive,
  ButtonContainer,
  MessageSquarePlus,
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
  appThemeClasses,
  sessionFromNavigation,
} from "@/app/utils.ts";
import type { ActiveChatView } from "@/app/types.ts";
import { TitlebarShell } from "@/butler-ds";
import { WindowControls } from "./WindowControls";

export function Titlebar() {
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const storeView = useButlerStore((state) => state.view);
  const storeNavigation = useButlerStore((state) => state.navigation);
  const storeActiveChatId = useButlerStore((state) => state.activeChatId);
  const leftOpen = useButlerStore((state) => state.leftOpen);
  const rightOpen = useButlerStore((state) => state.rightOpen);
  const rightAvailable = useButlerStore(selectRightAvailable);
  const settings = useButlerStore((state) => state.settings);
  const runSessionAction = useButlerStore((state) => state.runSessionAction);
  const setRightOpen = useButlerStore((state) => state.setRightOpen);
  const openNewChat = useButlerStore((state) => state.openNewChat);
  const { title, subtitle } = useMemo(
    () =>
      activeTitleForView(
        storeView,
        activeChatFromNavigation(
          storeNavigation,
          storeActiveChatId,
        ) as ActiveChatView,
      ),
    [storeActiveChatId, storeNavigation, storeView],
  );
  const activeSession =
    storeView.kind === "session" && isServerBackedSessionId(storeActiveChatId)
      ? sessionFromNavigation(storeNavigation, storeActiveChatId)
      : null;

  return (
    <TitlebarShell
      title={<span data-test-class="titlebar-title">{title}</span>}
      subtitle={
        subtitle ? (
          <span data-test-class="titlebar-subtitle">{subtitle}</span>
        ) : undefined
      }
      leading={
        storeView.kind === "session" ? (
          <IconButton
            className="titlebar-new-chat-button"
            data-test-class="titlebar-new-chat-button"
            label={appCopy.sidebar.newChat}
            onClick={openNewChat}
          >
            <MessageSquarePlus size={15} />
          </IconButton>
        ) : undefined
      }
      leadingVisibility="narrow"
      collapsed={!leftOpen}
      className="drag-region"
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
                  <MoreHorizontal size={16} />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className={appThemeClasses(settings)}
                align="end"
                onInteractOutside={() => setSessionMenuOpen(false)}
                sideOffset={TITLEBAR_MENU_SIDE_OFFSET_PX}
              >
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    onSelect={() => runSessionAction(activeSession, "rename")}
                  >
                    <PencilLine size={14} /> {appCopy.sessionActions.rename}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => runSessionAction(activeSession, "archive")}
                  >
                    <Archive size={14} /> {appCopy.sessionActions.archive}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
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
                <PanelRightClose size={17} />
              ) : (
                <PanelRight size={17} />
              )}
            </IconButton>
          )}
        </ButtonContainer>
      }
    />
  );
}
