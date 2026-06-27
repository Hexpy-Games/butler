import type {
  MutableRefObject,
  RefObject,
} from "react";
import type {
  AccessMode,
  ComposerControls,
  ReasoningEffort,
} from "@/app/types.ts";
import type { ComposerAttachment } from "./useFileAttachments";
import type { ComposerControlPatch } from "./useComposerControls";
import { useComposerControlHandlers } from "./useComposerControlHandlers";
import { useComposerFocus } from "./useComposerFocus";
import { useComposerKeyboard } from "./useComposerKeyboard";
import { useComposerSubmit } from "./useComposerSubmit";
import { useModelChoice } from "./useModelChoice";

interface UseComposerHandlersProps {
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
  setModel: (model: string) => void;
  setReasoning: (reasoning: ReasoningEffort) => void;
  setAccessMode: (mode: AccessMode) => void;
  setPlanMode: (mode: boolean) => void;
  setModelMenuOpen: (open: boolean) => void;
  setAccessMenuOpen: (open: boolean) => void;
  persistControls: (partial: ComposerControlPatch) => void;
  composerSelectionTouchedRef: MutableRefObject<boolean>;
  textAreaRef: RefObject<HTMLTextAreaElement | null>;
  isComposing: boolean;
  multilineSendBehavior?: string;
  onSend: (text: string, controls: ComposerControls) => void;
}

export function useComposerHandlers(props: UseComposerHandlersProps) {
  const {
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
    setModel,
    setReasoning,
    setAccessMode,
    setPlanMode,
    setModelMenuOpen,
    setAccessMenuOpen,
    persistControls,
    composerSelectionTouchedRef,
    textAreaRef,
    isComposing,
    multilineSendBehavior,
    onSend,
  } = props;
  const {
    handleAccessModeChange,
    handlePlanModeChange,
    handleReasoningChange,
  } = useComposerControlHandlers({
    composerSelectionTouchedRef,
    persistControls,
    setAccessMode,
    setPlanMode,
    setReasoning,
  });
  const handleModelChoice = useModelChoice(
    reasoning,
    setModel,
    setReasoning,
    persistControls,
    composerSelectionTouchedRef,
  );
  const submit = useComposerSubmit({
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
    controlsTouched: composerSelectionTouchedRef.current,
    setModelMenuOpen,
    setAccessMenuOpen,
    onSend,
  });
  const handleKeyDown = useComposerKeyboard({
    isComposing,
    multilineSendBehavior,
    setModelMenuOpen,
    setAccessMenuOpen,
    submit,
  });
  const focusDraftFromComposerChrome = useComposerFocus({ textAreaRef });

  return {
    submit,
    handleKeyDown,
    focusDraftFromComposerChrome,
    handleModelChoice,
    handleAccessModeChange,
    handlePlanModeChange,
    handleReasoningChange,
  };
}
