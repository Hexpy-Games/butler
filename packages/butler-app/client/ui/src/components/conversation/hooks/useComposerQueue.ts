import { useEffect } from "react";
import { browserRandomUUID } from "@/app/id.ts";
import { useButlerStore } from "@/app/store.ts";
import { useComposerStore } from "../composerStore";
import { focusComposer } from "../editor/focusComposer";
import type {
  QueuedMessageRecord,
  SessionSummaryView,
} from "@/app/types.ts";

interface UseComposerQueueProps {
  enabled?: boolean;
  activeChatId: string;
  summary: SessionSummaryView | null;
}

/** Keeps the session queue fresh; the conversation shows it (QueuedMessage). */
export function useComposerQueue({
  enabled = true,
  activeChatId,
  summary,
}: UseComposerQueueProps) {
  const refreshSessionQueue = useButlerStore(
    (state) => state.refreshSessionQueue,
  );

  useEffect(() => {
    if (!enabled) return;
    void refreshSessionQueue(activeChatId);
  }, [
    enabled,
    activeChatId,
    refreshSessionQueue,
    summary?.latest_progress?.state,
    summary?.latest_progress?.turn_id,
    summary?.turn_state,
  ]);
}

/**
 * Edit a queued (or failed) message: load its text, content parts and
 * attachments into the composer, remove it from the queue and focus the
 * editor.
 */
export function loadQueuedMessageIntoComposer(message: QueuedMessageRecord) {
  const composer = useComposerStore.getState();
  if (message.content_parts) composer.setContentParts(message.content_parts);
  else composer.setText(message.text);
  composer.setAttachments(
    (message.attachments ?? []).map((file) => ({
      id: `queued-${file.file_id}-${browserRandomUUID()}`,
      file,
      kind: file.kind,
    })),
  );
  void useButlerStore.getState().deleteQueuedMessage(message.id);
  window.requestAnimationFrame(() => focusComposer(composer.textAreaRef?.current));
}
