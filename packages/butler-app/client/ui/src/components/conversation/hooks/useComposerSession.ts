import { useButlerStore } from "@/app/store.ts";
import type { ComposerControls } from "@/app/types.ts";

export interface ComposerDraftScope {
  draftKey: string;
  targetChatId: string;
  isSending: boolean;
  onSend: (text: string, controls: ComposerControls) => Promise<void>;
}

export function useComposerSession(scope?: ComposerDraftScope) {
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const summary = useButlerStore((state) => state.summary);
  const turnProgress = useButlerStore((state) => state.turnProgress);
  const settings = useButlerStore((state) => state.settings);
  const modelCatalog = useButlerStore((state) => state.modelCatalog);
  const modelCatalogState = useButlerStore(
    (state) => state.modelCatalogState,
  );
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
    activeChatId: scope?.targetChatId ?? activeChatId,
    cancelActiveTurn,
    clearPendingProjectDocumentAttachment,
    isActiveChatSending: scope ? scope.isSending :
      isSending &&
      (sendingChatId === activeChatId ||
        Object.values(sendingOperations).includes(activeChatId)),
    modelCatalog,
    modelCatalogState,
    pendingProjectDocumentAttachment: scope ? null : pendingProjectDocumentAttachment,
    sendMessage: scope?.onSend ?? sendMessage,
    settings,
    summary: scope ? null : summary,
    turnProgress: scope ? {} : turnProgress,
  };
}
