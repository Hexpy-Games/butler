import { useCallback } from "react";
import type { FormEvent } from "react";
import type {
  AccessMode,
  ComposerControls,
  ReasoningEffort,
} from "@/app/types.ts";
import type { KeyboardEventLike } from "./composerEventTypes";
import type { ComposerAttachment } from "./useFileAttachments";

interface UseComposerSubmitProps {
  text: string;
  setText: (text: string) => void;
  attachments: ComposerAttachment[];
  setAttachments: (attachments: ComposerAttachment[]) => void;
  isSending: boolean;
  activeTurn: boolean;
  uploadingCount: number;
  model: string;
  reasoning: ReasoningEffort;
  accessMode: AccessMode;
  planMode: boolean;
  setModelMenuOpen: (open: boolean) => void;
  setAccessMenuOpen: (open: boolean) => void;
  onSend: (text: string, controls: ComposerControls) => void;
}

export function useComposerSubmit({
  text,
  setText,
  attachments,
  setAttachments,
  isSending,
  activeTurn,
  uploadingCount,
  model,
  reasoning,
  accessMode,
  planMode,
  setModelMenuOpen,
  setAccessMenuOpen,
  onSend,
}: UseComposerSubmitProps) {
  return useCallback(
    (event: FormEvent<HTMLFormElement> | KeyboardEventLike) => {
      event.preventDefault();
      const value = text.trim();
      if (
        (!value && attachments.length === 0) ||
        (isSending && !activeTurn) ||
        uploadingCount > 0
      ) {
        return;
      }
      const fileRefs = attachments.map((attachment) => attachment.file);
      setText("");
      setAttachments([]);
      setModelMenuOpen(false);
      setAccessMenuOpen(false);
      onSend(value, {
        model,
        reasoningEffort: reasoning,
        accessMode,
        planMode,
        queuePolicy: activeTurn ? "enqueue_if_busy" : "send_now",
        attachments: fileRefs,
      });
    },
    [
      text,
      attachments,
      isSending,
      activeTurn,
      uploadingCount,
      setText,
      setAttachments,
      setModelMenuOpen,
      setAccessMenuOpen,
      onSend,
      model,
      reasoning,
      accessMode,
      planMode,
    ],
  );
}
