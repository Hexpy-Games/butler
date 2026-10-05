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
import { recordSendOrigin } from "@/butler-ds";
import { readLocalComposerDraft, writeCachedComposerDraft } from "@/app/composerDraftCache";

interface UseComposerSubmitProps {
  text: string;
  readText?: () => string;
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
  readText,
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
      const draftText = readText?.() ?? text;
      const value = draftText.trim();
      if (
        (!value && attachments.length === 0) ||
        useComposerStore.getState().blockedAttachments.size > 0 ||
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
      // The sent bubble flies from where the text sat (DS send flight).
      recordSendOrigin(submitted.textAreaRef?.current);
      onSend(draftText, { ...composerControlsForSubmit({
        model,
        reasoning,
        accessMode,
        planMode,
        controlsTouched,
        activeTurn,
        attachments,
      }), contentParts, workspaceMode: submitted.workspaceMode, onAccepted: () => {
        const current = useComposerStore.getState();
        if (current.draftSessionId === sessionId && current.draftRevision === revision) {
          current.setWorkspaceMode("local");
          setText("");
          if (current.attachments === attachments) setAttachments([]);
        } else if (current.draftSessionId !== sessionId) {
          // Session creation changes the active ID before the send is acknowledged.
          // Only clear the submitted cache, never the newly active editor.
          const cached = readLocalComposerDraft(sessionId);
          if (cached?.text === draftText && JSON.stringify(cached.content_parts) === JSON.stringify(contentParts)) {
            writeCachedComposerDraft(sessionId, "");
          }
        }
      } });
    },
    [
      readText,
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
