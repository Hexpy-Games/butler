import { TitlebarSessionMenu } from "./TitlebarSessionMenu.tsx";
import { useSessionInfoHasContent } from "../session-info/useSessionSectionsModel.ts";
import { SessionInfoActions } from "../session-info/SessionInfoActions.tsx";
import { useAppLocale } from "@/app/copy.ts";
import { useMemo, useState } from "react";
import { ButtonContainer } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { isServerBackedSessionId } from "@/app/sessionIds.ts";
import { useButlerStore } from "@/app/store.ts";
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
import { FileViewerToggle } from "../file-viewer/FileViewerToggle";
import { useViewerTakesWorkspace } from "../file-viewer/useRightSlot";
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
  // On a phone the viewer replaces the chat: 세션 정보 has nothing to show beside it.
  const viewerTakesWorkspace = useViewerTakesWorkspace(storeActiveChatId);
  const hasInfoContent = useSessionInfoHasContent();
  const graphEnabled = useButlerStore(state => state.taskGraphEnabled);
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
      chatTrailing={storeView.kind === "session" && !viewerTakesWorkspace && (hasInfoContent || graphEnabled) ? <SessionInfoActions /> : undefined}
      trailing={
        <ButtonContainer size="icon-sm" data-test-class="project-controls">
          {storeView.kind === "session" && <FileViewerToggle />}
          {storeView.kind === "session" && isServerBackedSessionId(storeActiveChatId) && <BrowserToggle />}
        </ButtonContainer>
      }
    />
  );
}
