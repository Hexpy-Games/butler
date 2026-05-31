import { useButlerStore } from "@/app/store.ts";

export function useComposerSession() {
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const summary = useButlerStore((state) => state.summary);
  const turnProgress = useButlerStore((state) => state.turnProgress);
  const settings = useButlerStore((state) => state.settings);
  const modelCatalog = useButlerStore((state) => state.modelCatalog);
  const isSending = useButlerStore((state) => state.isSending);
  const sendingChatId = useButlerStore((state) => state.sendingChatId);
  const sendingOperations = useButlerStore((state) => state.sendingOperations);
  const sendMessage = useButlerStore((state) => state.sendMessage);
  const cancelActiveTurn = useButlerStore((state) => state.cancelActiveTurn);
  const pendingProjectDocumentAttachment = useButlerStore(
    (state) => state.pendingProjectDocumentAttachment,
  );
  const clearPendingProjectDocumentAttachment = useButlerStore(
    (state) => state.clearPendingProjectDocumentAttachment,
  );

  return {
    activeChatId,
    cancelActiveTurn,
    clearPendingProjectDocumentAttachment,
    isActiveChatSending:
      isSending &&
      (sendingChatId === activeChatId ||
        Object.values(sendingOperations).includes(activeChatId)),
    modelCatalog,
    pendingProjectDocumentAttachment,
    sendMessage,
    settings,
    summary,
    turnProgress,
  };
}
