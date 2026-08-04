import { useRef, useState } from "react";
import { ComposerAdjunctPanels, composerHasAdjunct } from "./ComposerAdjunctPanels";
import { ComposerInputSurface } from "./ComposerInputSurface";
import { useComposerStore } from "./composerStore";
import { useComposerControls } from "./hooks/useComposerControls";
import { useComposerDraftSession } from "./hooks/useComposerDraftSession";
import { useFileAttachments } from "./hooks/useFileAttachments";
import { useComposerHandlers } from "./hooks/useComposerHandlers";
import { useComposerQueue } from "./hooks/useComposerQueue";
import { useComposerSession } from "./hooks/useComposerSession";
import { useComposerState } from "./hooks/useComposerState";
import { useComposerStoreBridge } from "./hooks/useComposerStoreBridge";
import { usePendingProjectDocumentAttachment } from "./hooks/usePendingProjectDocumentAttachment";
import { useComposerPresentation } from "./hooks/useComposerPresentation";
import { useComposerFileDrop } from "./hooks/useComposerFileDrop";
import { useReserveHeight } from "./hooks/useReserveHeight";
import { ComposerCard } from "@/butler-ds";
import { GitDependencyNotice } from "./GitDependencyNotice";

interface ComposerProps {
  onReserveChange: (height: number) => void;
  onOpenContext: () => void;
  large: boolean;
}
export function Composer({ large, onOpenContext, onReserveChange }: ComposerProps) {
  const session = useComposerSession();
  useComposerDraftSession(session.activeChatId);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [accessMenuOpen, setAccessMenuOpen] = useState(false);
  const [contextPopoverOpen, setContextPopoverOpen] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const text = useComposerStore((store) => store.text);
  const setText = useComposerStore((store) => store.setText);
  const submit = useComposerStore((store) => store.submit);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const controls = useComposerControls(
    session.activeChatId,
    session.modelCatalog,
    session.modelCatalogState,
    session.settings,
  );
  const files = useFileAttachments(session.activeChatId);
  const fileDrop = useComposerFileDrop((nextFiles) => void files.addFiles(nextFiles));

  usePendingProjectDocumentAttachment({
    activeChatId: session.activeChatId,
    clearPendingProjectDocumentAttachment:
      session.clearPendingProjectDocumentAttachment,
    files,
    pendingProjectDocumentAttachment: session.pendingProjectDocumentAttachment,
  });

  const state = useComposerState(
    session.summary,
    session.turnProgress,
    session.settings,
    session.modelCatalog,
    controls.model,
    controls.modelState,
    text,
    files.attachments,
    session.isActiveChatSending,
    files.uploadingCount,
  );
  const handlers = useComposerHandlers({
    text,
    setText,
    attachments: files.attachments,
    setAttachments: files.setAttachments,
    isSending: session.isActiveChatSending,
    activeTurn: state.activeTurn,
    uploadingCount: files.uploadingCount,
    model: controls.model,
    reasoning: controls.reasoning,
    accessMode: controls.accessMode,
    planMode: controls.planMode,
    setModel: controls.setModel,
    setReasoning: controls.setReasoning,
    setAccessMode: controls.setAccessMode,
    setPlanMode: controls.setPlanMode,
    setModelMenuOpen,
    setAccessMenuOpen,
    persistControls: controls.persistControls,
    composerSelectionTouchedRef: controls.composerSelectionTouchedRef,
    textAreaRef,
    isComposing,
    multilineSendBehavior: session.settings.multiline_send_behavior,
    onSend: session.sendMessage,
  });
  const queue = useComposerQueue({
    activeChatId: session.activeChatId,
    files,
    setText,
    summary: session.summary,
    textAreaRef,
  });

  useReserveHeight(wrapRef, onReserveChange);
  useComposerStoreBridge({
    accessMenuOpen,
    contextPopoverOpen,
    controls,
    fileInputRef,
    files,
    handlers,
    isSending: session.isActiveChatSending,
    large,
    modelMenuOpen,
    onOpenContext,
    onStop: session.cancelActiveTurn,
    setAccessMenuOpen,
    setContextPopoverOpen,
    setIsComposing,
    setModelMenuOpen,
    state,
    textAreaRef,
  });
  const showAdjunct = composerHasAdjunct(queue.sessionQueue.length, state.workers.length, state.taskRows.length);
  const presentation = useComposerPresentation({
    activeChatId: session.activeChatId,
    containerRef: wrapRef,
    protectedExpanded: modelMenuOpen || accessMenuOpen || contextPopoverOpen,
  });

  return (
    <ComposerCard
      {...fileDrop}
      large={large}
      expanded={presentation.expanded}
      floating
      notice={<GitDependencyNotice />}
      adjunct={
        showAdjunct ? (
          <ComposerAdjunctPanels
            queuedMessages={queue.sessionQueue}
            onEditQueued={queue.handleEditQueued}
            onDeleteQueued={queue.handleDeleteQueued}
            showWorkers={state.workers.length > 0}
            taskRows={state.taskRows}
            taskTurnState={state.taskTurnState}
          />
        ) : null
      }
      containerRef={wrapRef}
      onPointerDown={handlers.focusDraftFromComposerChrome}
      onPointerDownCapture={presentation.onPointerDownCapture}
      onFocusCapture={presentation.onFocusCapture}
      onBlurCapture={presentation.onBlurCapture}
      onSubmit={submit}
    >
      <ComposerInputSurface
        fileInputRef={fileInputRef}
        onFiles={(nextFiles) => void files.addFiles(nextFiles)}
      />
    </ComposerCard>
  );
}
