import { useLayoutEffect } from "react";
import type {
  Dispatch,
  RefObject,
  SetStateAction,
} from "react";
import { useComposerStore } from "../composerStore";
import type { useComposerControls } from "./useComposerControls";
import type { useComposerHandlers } from "./useComposerHandlers";
import type { useComposerState } from "./useComposerState";
import type { useFileAttachments } from "./useFileAttachments";

interface UseComposerStoreBridgeProps {
  accessMenuOpen: boolean;
  contextPopoverOpen: boolean;
  controls: ReturnType<typeof useComposerControls>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  files: ReturnType<typeof useFileAttachments>;
  handlers: ReturnType<typeof useComposerHandlers>;
  isSending: boolean;
  large: boolean;
  modelMenuOpen: boolean;
  onOpenContext: () => void;
  onStop: () => void;
  setAccessMenuOpen: Dispatch<SetStateAction<boolean>>;
  setContextPopoverOpen: Dispatch<SetStateAction<boolean>>;
  setIsComposing: Dispatch<SetStateAction<boolean>>;
  setModelMenuOpen: Dispatch<SetStateAction<boolean>>;
  state: ReturnType<typeof useComposerState>;
  textAreaRef: RefObject<HTMLTextAreaElement | null>;
}

export function useComposerStoreBridge(props: UseComposerStoreBridgeProps) {
  const {
    accessMenuOpen,
    contextPopoverOpen,
    controls,
    fileInputRef,
    files,
    handlers,
    isSending,
    large,
    modelMenuOpen,
    onOpenContext,
    onStop,
    setAccessMenuOpen,
    setContextPopoverOpen,
    setIsComposing,
    setModelMenuOpen,
    state,
    textAreaRef,
  } = props;

  useLayoutEffect(() => {
    useComposerStore.getState().setSnapshot({
      accessMenuOpen,
      activeModel: state.activeModel ?? null,
      activeTurn: state.activeTurn,
      addFiles: files.addFiles,
      addProjectDocument: files.addProjectDocument,
      attachments: files.attachments,
      availableReasoning: state.availableReasoning,
      canSend: state.canSend,
      canStop: state.canStop,
      context: state.context,
      contextPopoverOpen,
      fileInputRef,
      focusDraftFromComposerChrome: handlers.focusDraftFromComposerChrome,
      handleAccessModeChange: handlers.handleAccessModeChange,
      handleKeyDown: handlers.handleKeyDown,
      handleModelChoice: handlers.handleModelChoice,
      handlePlanModeChange: handlers.handlePlanModeChange,
      handleReasoningChange: handlers.handleReasoningChange,
      isSending,
      large,
      model: controls.model,
      modelState: controls.modelState,
      modelMenuOpen,
      models: state.models,
      onOpenContext,
      onStop,
      planMode: controls.planMode,
      popoverThemeClass: state.popoverThemeClass,
      reasoning: controls.reasoning,
      accessMode: controls.accessMode,
      setAccessMenuOpen,
      setAttachments: files.setAttachments,
      setContextPopoverOpen,
      setIsComposing,
      setModelMenuOpen,
      submit: handlers.submit,
      textAreaRef,
      uploadingCount: files.uploadingCount,
      workers: state.workers,
    });
  });
}
