import { CanonInlineDraftProvider } from "../canon/CanonInlineDraft.tsx";
import { ConversationRequestProvider } from "./ConversationRequestContext.tsx";
import { useSessionInfoHasContent } from "../session-info/useSessionSectionsModel.ts";
import { SessionSections } from "../session-info/SessionSections.tsx";
import { ComposerCrashFallback } from "./ComposerCrashFallback.tsx";
import { ErrorBoundary } from "@/components/common/ErrorBoundary.tsx";
import { useAppLocale } from "@/app/copy.ts";
import { useCallback, useMemo, useState } from "react";
import { activeChatFromNavigation } from "@/app/utils.ts";
import { appCopy } from "@/app/copy.ts";
import { selectActiveAuthorityApprovals, useButlerStore } from "@/app/store.ts";
import { useAppearanceTheme } from "@/stores/appearanceStore.ts";
import { useConversationWallpaper } from "./hooks/useConversationWallpaper";
import { EmptyState } from "./EmptyState";
import { BranchProjectContext } from "./AssistantBranchActions";
import { useConversationMessages } from "./useConversationMessages.ts";
import { useChatsIntroVisible } from "./ChatsIntro";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import {
  DEFAULT_COMPOSER_RESERVE,
  COMPOSER_FLOAT_BOTTOM,
  COMPOSER_CONTENT_GAP,
  resolveButlerMarkTheme,
} from "./conversationUtils";
import { ConversationScroll, ConversationShell } from "@/butler-ds";
import { useSessionViewSubscription } from
  "@/components/layout/hooks/useSessionViewSubscription.ts";

import { AgentTabRail } from "../browser/AgentTabRail";
import { useBrowserShellState } from "../browser/browserShellState";
import { useRightSlot } from "../file-viewer/useRightSlot";

void appCopy;

export function Conversation() {
  const locale = useAppLocale();
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const infoOpen = useButlerStore(state => state.sessionInfoOpen);
  const hasContent = useSessionInfoHasContent();
  const infoShown = infoOpen && hasContent;
  const browserOpen = useBrowserShellState(state => Boolean(state.conversations[activeChatId]?.open));
  const viewerShown = useRightSlot(activeChatId) === "viewer";
  const branchProjectId = useButlerStore((state) => {
    if (activeChatId === "general") return null;
    const view = state.sessionViews[activeChatId] ??
      (state.sessionView?.session_id === activeChatId ? state.sessionView : null);
    return view?.project_id ?? null;
  });
  const navigation = useButlerStore((state) => state.navigation);
  const pendingQuestions = useButlerStore(state => state.sessionViews[activeChatId]?.pending_questions
    ?? (state.sessionView?.session_id === activeChatId ? state.sessionView.pending_questions : undefined));
  const messages = useConversationMessages(activeChatId);
  const approvals = useButlerStore(selectActiveAuthorityApprovals);
  const summary = useButlerStore((state) => state.summary);
  const turnProgress = useButlerStore((state) => state.turnProgress);
  const messageLoadPending = useButlerStore(
    (state) => state.messageLoadPending,
  );
  const appearanceTheme = useAppearanceTheme();
  const isSending = useButlerStore((state) => state.isSending);
  const sendingChatId = useButlerStore((state) => state.sendingChatId);
  const sendingOperations = useButlerStore((state) => state.sendingOperations);
  const sendMessage = useButlerStore((state) => state.sendMessage);
  const refreshSessionView = useButlerStore((state) => state.refreshSessionView);

  const activeChat = useMemo(
    () => activeChatFromNavigation(navigation, activeChatId),
    [activeChatId, navigation, locale],
  );
  const isActiveChatSending =
    isSending &&
    (sendingChatId === activeChatId ||
      Object.values(sendingOperations).includes(activeChatId));

  const [composerReserve, setComposerReserve] = useState(
    DEFAULT_COMPOSER_RESERVE,
  );
  const updateComposerReserve = useCallback((height: number) => {
    const nextReserve = Math.ceil(
      height + COMPOSER_FLOAT_BOTTOM + COMPOSER_CONTENT_GAP,
    );
    setComposerReserve((current) =>
      Math.abs(current - nextReserve) < 1 ? current : nextReserve,
    );
  }, []);

  const hasTranscript = useChatsIntroVisible() || messages.length > 0;
  const stewardParentSubscriptionId = summary?.steward_children?.some(
    (child) => child.active_turn,
  ) ? activeChatId : null;
  useSessionViewSubscription(stewardParentSubscriptionId, refreshSessionView);
  const hasDurableActivity = Boolean(
    summary?.steward_children?.some((child) => child.active_turn) ||
    summary?.latest_progress?.safe_progress_rows?.length,
  );
  const showMessageList = hasTranscript || Boolean(pendingQuestions?.length || approvals.length) || hasDurableActivity || Boolean(summary?.branch_seed);
  const showEmptyState = !showMessageList && !messageLoadPending;
  const wallpaper = useConversationWallpaper(showEmptyState, isActiveChatSending);
  const composerLarge = true;
  const newChatTitleIconSize = showEmptyState
    ? "clamp(40px, 5.333vw, 54px)"
    : undefined;
  const newChatTitleIconGap = showEmptyState ? "10px" : undefined;
  const newChatTitleIconGutter = showEmptyState
    ? "calc(clamp(40px, 5.333vw, 54px) + clamp(40px, 5.333vw, 54px) + 10px)"
    : undefined;
  const markTheme = resolveButlerMarkTheme(appearanceTheme);
  return (
    <ConversationRequestProvider key={activeChatId}><CanonInlineDraftProvider><ConversationShell
      asideLabel={appCopy.sessionInfo.title}
      asideFloatOpen={infoShown}
      aside={infoShown ? layout => <SessionSections key={activeChatId} layout={layout} /> : undefined}
      railView={activeChatId}
      rail={window.butlerBrowser && !browserOpen && !viewerShown && !infoShown ? <AgentTabRail session={activeChatId} /> : undefined}
      background={wallpaper.background}
      composerReserve={composerReserve}
      contentGutter={newChatTitleIconGutter}
      titleIconGap={newChatTitleIconGap}
      titleIconSize={newChatTitleIconSize}
    >
      {showMessageList ? (
        <BranchProjectContext.Provider value={branchProjectId}>
          <ErrorBoundary key={activeChatId} scope="messages">
            <MessageList
              onColumnRect={wallpaper.onColumnRect}
              messages={messages}
              turnProgress={turnProgress}
              bottomReserve={composerReserve}
              isSending={isActiveChatSending}
            />
          </ErrorBoundary>
        </BranchProjectContext.Provider>
      ) : showEmptyState ? (
        <ConversationScroll masked={false} scrollable={false}>
          <EmptyState
            onContentRect={wallpaper.onContentRect}
            activeChat={activeChat}
            isSending={isActiveChatSending}
            markTheme={markTheme}
            onSend={sendMessage}
          />
        </ConversationScroll>
      ) : (
        <ConversationScroll>{null}</ConversationScroll>
      )}
      <ErrorBoundary key={activeChatId} scope="composer"
        fallback={(retry) => <ComposerCrashFallback retry={retry} onReserveChange={updateComposerReserve} />}>
        <Composer
          onWallpaperRect={wallpaper.onComposerRect}
          onReserveChange={updateComposerReserve}
          large={composerLarge}
        />
      </ErrorBoundary>
    </ConversationShell></CanonInlineDraftProvider></ConversationRequestProvider>
  );
}
