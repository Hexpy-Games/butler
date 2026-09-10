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
import { useComposerStore } from "../composerStore";
import { useButlerStore } from "@/app/store.ts";
import { readLocalComposerDraft, writeCachedComposerDraft } from "@/app/composerDraftCache";

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
      if (useButlerStore.getState().liveConnectionLost) return;
      const value = text.trim();
      if (
        (!value && attachments.length === 0) ||
        (isSending && !activeTurn) ||
        uploadingCount > 0
      ) {
        return;
      }
      const submitted = useComposerStore.getState();
      const revision = submitted.draftRevision;
      const sessionId = submitted.draftSessionId;
      const contentParts = submitted.contentParts;
      setModelMenuOpen(false);
      setAccessMenuOpen(false);
      onSend(contentParts ? text : value, { ...composerControlsForSubmit({
        model,
        reasoning,
        accessMode,
        planMode,
        controlsTouched,
        activeTurn,
        attachments,
      }), contentParts, onAccepted: () => {
        const current = useComposerStore.getState();
        if (current.draftSessionId === sessionId && current.draftRevision === revision) {
          setText("");
          if (current.attachments === attachments) setAttachments([]);
        } else if (current.draftSessionId !== sessionId) {
          // Session creation changes the active ID before the send is acknowledged.
          // Only clear the submitted cache, never the newly active editor.
          const cached = readLocalComposerDraft(sessionId);
          if (cached?.text === text && JSON.stringify(cached.content_parts) === JSON.stringify(contentParts)) {
            writeCachedComposerDraft(sessionId, "");
          }
        }
      } });
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
