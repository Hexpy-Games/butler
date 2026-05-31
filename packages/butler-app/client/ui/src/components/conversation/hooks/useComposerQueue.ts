import { useEffect } from "react";
import type { RefObject } from "react";
import { useButlerStore } from "@/app/store.ts";
import type {
  QueuedMessageRecord,
  SessionSummaryView,
} from "@/app/types.ts";
import type { useFileAttachments } from "./useFileAttachments";

interface UseComposerQueueProps {
  activeChatId: string;
  summary: SessionSummaryView | null;
  files: ReturnType<typeof useFileAttachments>;
  setText: (text: string) => void;
  textAreaRef: RefObject<HTMLTextAreaElement | null>;
}

export function useComposerQueue({
  activeChatId,
  summary,
  files,
  setText,
  textAreaRef,
}: UseComposerQueueProps) {
  const sessionQueue = useButlerStore((state) => state.sessionQueue);
  const refreshSessionQueue = useButlerStore(
    (state) => state.refreshSessionQueue,
  );
  const deleteQueuedMessage = useButlerStore(
    (state) => state.deleteQueuedMessage,
  );

  useEffect(() => {
    void refreshSessionQueue(activeChatId);
  }, [
    activeChatId,
    refreshSessionQueue,
    summary?.latest_progress?.state,
    summary?.latest_progress?.turn_id,
    summary?.turn_state,
  ]);

  const handleEditQueued = (message: QueuedMessageRecord) => {
    setText(message.text);
    files.setAttachments(
      (message.attachments ?? []).map((file) => ({
        id: `queued-${file.file_id}-${crypto.randomUUID()}`,
        file,
        kind: file.kind,
      })),
    );
    void deleteQueuedMessage(message.id);
    window.requestAnimationFrame(() => textAreaRef.current?.focus());
  };

  const handleDeleteQueued = (message: QueuedMessageRecord) => {
    void deleteQueuedMessage(message.id);
  };

  return {
    sessionQueue,
    handleEditQueued,
    handleDeleteQueued,
  };
}
