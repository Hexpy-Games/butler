import { useCallback, useMemo, useState } from "react";
import { activeChatFromNavigation } from "@/app/utils.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { EmptyState } from "./EmptyState";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import {
  DEFAULT_COMPOSER_RESERVE,
  COMPOSER_FLOAT_BOTTOM,
  COMPOSER_CONTENT_GAP,
  resolveButlerMarkTheme,
} from "./conversationUtils";
import { ConversationScroll, ConversationShell } from "@/butler-ds";

void appCopy;

export function Conversation() {
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const navigation = useButlerStore((state) => state.navigation);
  const messages = useButlerStore((state) => state.messages);
  const turnProgress = useButlerStore((state) => state.turnProgress);
  const messageLoadPending = useButlerStore(
    (state) => state.messageLoadPending,
  );
  const appearanceTheme = useButlerStore(
    (state) => state.settings.appearance_theme,
  );
  const isSending = useButlerStore((state) => state.isSending);
  const sendingChatId = useButlerStore((state) => state.sendingChatId);
  const sendingOperations = useButlerStore((state) => state.sendingOperations);
  const sendMessage = useButlerStore((state) => state.sendMessage);
  const setRightOpen = useButlerStore((state) => state.setRightOpen);
  const setRightTab = useButlerStore((state) => state.setRightTab);

  const activeChat = useMemo(
    () => activeChatFromNavigation(navigation, activeChatId),
    [activeChatId, navigation],
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
  const openContext = useCallback(() => {
    setRightOpen(true);
    setRightTab("context");
  }, [setRightOpen, setRightTab]);

  const hasMessages = messages.length > 0;
  const showEmptyState = !hasMessages && !messageLoadPending;
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
      {hasMessages ? (
        <MessageList
          messages={messages}
          turnProgress={turnProgress}
          bottomReserve={composerReserve}
          isSending={isActiveChatSending}
          markTheme={markTheme}
        />
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
      <Composer
        onReserveChange={updateComposerReserve}
        onOpenContext={openContext}
        large={composerLarge}
      />
    </ConversationShell>
  );
}
