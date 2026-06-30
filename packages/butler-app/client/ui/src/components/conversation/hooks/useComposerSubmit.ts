import { useCallback } from "react";
import type { FormEvent } from "react";
import type {
  AccessMode,
  ComposerControls,
  ReasoningEffort,
} from "@/app/types.ts";
import type { KeyboardEventLike } from "./composerEventTypes";
import { composerControlsForSubmit } from "./composerSubmitControls";
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
  controlsTouched: boolean;
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
  controlsTouched,
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
      setText("");
      setAttachments([]);
      setModelMenuOpen(false);
      setAccessMenuOpen(false);
      onSend(value, composerControlsForSubmit({
        model,
        reasoning,
        accessMode,
        planMode,
        controlsTouched,
        activeTurn,
        attachments,
      }));
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
      controlsTouched,
    ],
  );
}
