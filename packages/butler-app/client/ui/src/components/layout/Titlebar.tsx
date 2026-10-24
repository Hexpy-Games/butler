import { TitlebarSessionMenu } from "./TitlebarSessionMenu.tsx";
import { SessionInfoActions } from "../session-info/SessionInfoActions.tsx";
import { useAppLocale } from "@/app/copy.ts";
import { useMemo, useState } from "react";
import {
  ButtonContainer,
  PanelRight,
} from "@/butler-ds";
import { IconButton } from "@/butler-ds";
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
import { TitlebarWorkspaceSubtitle } from "./TitlebarWorkspaceSubtitle";
import { WindowControls } from "./WindowControls";
import { BrowserToggle } from "../browser/BrowserToggle";
import { HubConversationButton } from "../browser/HubConversationButton";
import { libraryTitle, useLibraryNames } from "../library/libraryNav";
import { useTitlebarBack } from "@/app/navigationBack";

export function Titlebar({ sidebarOpen, splitChatWidth }: { sidebarOpen?: boolean; splitChatWidth?: number }) {
  useAppLocale();
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const storeView = useButlerStore((state) => state.view);
  const storeNavigation = useButlerStore((state) => state.navigation);
  const storeActiveChatId = useButlerStore((state) => state.activeChatId);
  const storeActiveChatTitle = useButlerStore((state) => state.activeChatTitle);
  const leftOpen = useButlerStore((state) => state.leftOpen);
  const rightOpen = useButlerStore((state) => state.rightOpen);
  const rightAvailable = useButlerStore(selectRightAvailable);
  const setRightOpen = useButlerStore((state) => state.setRightOpen);
  const back = useTitlebarBack();
  useLibraryNames();
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
  const canOpenSessionFolder = Boolean(hasWorkspaceIdentity && branchInfo?.workspace_status === "available");
  return (
    <TitlebarShell
      title={<span data-test-class="titlebar-title">{storeView.kind === "library" ? libraryTitle(storeView) : title}</span>}
      back={back}
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
      splitChatWidth={splitChatWidth}
      titleActions={activeSession ? <TitlebarSessionMenu activeSession={activeSession} canOpenSessionFolder={canOpenSessionFolder}
        sessionMenuOpen={sessionMenuOpen} setSessionMenuOpen={setSessionMenuOpen} /> : undefined}
      chatTrailing={storeView.kind === "session" ? <SessionInfoActions /> : undefined}
      trailing={
        <ButtonContainer size="icon-sm" data-test-class="project-controls">
          {storeView.kind === "session" && isServerBackedSessionId(storeActiveChatId) && <BrowserToggle />}
          {rightAvailable && (
            <IconButton
              data-test-class="titlebar-right-panel-toggle"
              label={
                rightOpen
                  ? appCopy.titlebar.hideRightPanel
                  : appCopy.titlebar.showRightPanel
              }
              pressed={rightOpen}
              tone={rightOpen ? "butler" : "default"}
              onClick={() => setRightOpen((value) => !value)}
            >
              <PanelRight size="md" />
            </IconButton>
          )}
        </ButtonContainer>
      }
    />
  );
}
