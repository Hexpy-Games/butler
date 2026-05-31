import { useRef, useState } from "react";
import { ComposerAdjunctPanels } from "./ComposerAdjunctPanels";
import { ComposerAttachments } from "./ComposerAttachments";
import { ComposerTextArea } from "./ComposerTextArea";
import { ComposerToolbar } from "./ComposerToolbar";
import { useComposerStore } from "./composerStore";
import { useComposerControls } from "./hooks/useComposerControls";
import { useFileAttachments } from "./hooks/useFileAttachments";
import { useComposerHandlers } from "./hooks/useComposerHandlers";
import { useComposerQueue } from "./hooks/useComposerQueue";
import { useComposerSession } from "./hooks/useComposerSession";
import { useComposerState } from "./hooks/useComposerState";
import { useComposerStoreBridge } from "./hooks/useComposerStoreBridge";
import { usePendingProjectDocumentAttachment } from "./hooks/usePendingProjectDocumentAttachment";
import { useReserveHeight } from "./hooks/useReserveHeight";
import { ComposerCard } from "@/butler-ds";

interface ComposerProps {
  onReserveChange: (height: number) => void;
  onOpenContext: () => void;
  large: boolean;
}

export function Composer(props: ComposerProps) {
  const { large, onOpenContext, onReserveChange } = props;
  const session = useComposerSession();
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [accessMenuOpen, setAccessMenuOpen] = useState(false);
  const [contextPopoverOpen, setContextPopoverOpen] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const text = useComposerStore((store) => store.text);
  const setText = useComposerStore((store) => store.setText);
  const submit = useComposerStore((store) => store.submit);
  const focusDraftFromComposerChrome = useComposerStore(
    (store) => store.focusDraftFromComposerChrome,
  );
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const controls = useComposerControls(
    session.activeChatId,
    session.modelCatalog,
    session.settings,
  );
  const files = useFileAttachments(session.activeChatId);

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
  const showAdjunct =
    queue.sessionQueue.length > 0 ||
    state.todoRows.length > 0 ||
    state.workers.length > 0;

  return (
    <ComposerCard
      large={large}
      floating
      adjunct={showAdjunct ? (
        <ComposerAdjunctPanels
          queuedMessages={queue.sessionQueue}
          onEditQueued={queue.handleEditQueued}
          onDeleteQueued={queue.handleDeleteQueued}
          todoRows={state.todoRows}
          showWorkers={state.workers.length > 0}
        />
      ) : null}
      containerRef={wrapRef}
      onPointerDown={focusDraftFromComposerChrome}
      onSubmit={submit}
    >
      <ComposerTextArea />
      <ComposerAttachments />
      <ComposerToolbar />
      <input
        ref={fileInputRef}
        data-picker-filter="all-files"
        hidden
        multiple
        type="file"
        onChange={(event) => {
          void files.addFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
    </ComposerCard>
  );
}
