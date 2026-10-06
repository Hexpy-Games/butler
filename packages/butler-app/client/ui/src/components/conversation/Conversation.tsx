import { ComposerCrashFallback } from "./ComposerCrashFallback.tsx";
import { ErrorBoundary } from "@/components/common/ErrorBoundary.tsx";
import { useAppLocale } from "@/app/copy.ts";
import { useCallback, useMemo, useState } from "react";
import { activeChatFromNavigation } from "@/app/utils.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useAppearanceTheme } from "@/stores/appearanceStore.ts";
import { EmptyState } from "./EmptyState";
import { BranchProjectContext } from "./AssistantBranchActions";
import { withQuestionAnswers } from "./userQuestions";
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

void appCopy;

export function Conversation() {
  const locale = useAppLocale();
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const branchProjectId = useButlerStore((state) => {
    if (activeChatId === "general") return null;
    const view = state.sessionViews[activeChatId] ??
      (state.sessionView?.session_id === activeChatId ? state.sessionView : null);
    return view?.project_id ?? null;
  });
  const navigation = useButlerStore((state) => state.navigation);
  const storedMessages = useButlerStore((state) => state.messages);
  const questionAnswers = useButlerStore(state => state.sessionViews[activeChatId]?.question_answers
    ?? (state.sessionView?.session_id === activeChatId ? state.sessionView.question_answers : undefined));
  const pendingQuestions = useButlerStore(state => state.sessionViews[activeChatId]?.pending_questions
    ?? (state.sessionView?.session_id === activeChatId ? state.sessionView.pending_questions : undefined));
  const messages = useMemo(() => withQuestionAnswers(storedMessages, questionAnswers ?? [], pendingQuestions ?? []), [storedMessages, questionAnswers, pendingQuestions]);
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

  const hasMessages = messages.length > 0;
  const stewardParentSubscriptionId = summary?.steward_children?.some(
    (child) => child.active_turn,
  ) ? activeChatId : null;
  useSessionViewSubscription(stewardParentSubscriptionId, refreshSessionView);
  const hasDurableActivity = Boolean(
    summary?.steward_children?.some((child) => child.active_turn) ||
    summary?.latest_progress?.safe_progress_rows?.length,
  );
  const showMessageList = hasMessages || hasDurableActivity || Boolean(summary?.branch_seed);
  const showEmptyState = !showMessageList && !messageLoadPending;
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
    <ConversationShell
      composerReserve={composerReserve}
      contentGutter={newChatTitleIconGutter}
      titleIconGap={newChatTitleIconGap}
      titleIconSize={newChatTitleIconSize}
    >
      {showMessageList ? (
        <BranchProjectContext.Provider value={branchProjectId}>
          <ErrorBoundary key={activeChatId} scope="messages">
            <MessageList
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
          onReserveChange={updateComposerReserve}
          large={composerLarge}
        />
      </ErrorBoundary>
    </ConversationShell>
  );
}
