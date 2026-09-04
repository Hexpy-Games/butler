import type {
  Dispatch,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
  SetStateAction,
} from "react";
import type {
  AccessMode,
  AppModelSummary,
  ComposerModelState,
  ContextDetailsView,
  ProjectDashboardDocument,
  ReasoningEffort,
  WorkerActivitySummary,
} from "@/app/types.ts";
import type { KeyboardEventLike } from "./hooks/composerEventTypes";
import type { ComposerAttachment } from "./hooks/useFileAttachments";

type AttachmentSetter = Dispatch<SetStateAction<ComposerAttachment[]>>;

export interface ComposerStore {
  draftRevision: number;
  draftSessionId: string;
  activateDraftSession: (sessionId: string, text: string) => number;
  restoreDraftSession: (input: {
    revision: number;
    sessionId: string;
    text: string;
  }) => boolean;
  engaged: boolean;
  setEngaged: (engaged: boolean) => void;
  text: string;
  setText: (text: string) => void;
  setIsComposing: (value: boolean) => void;
  large: boolean;
  textAreaRef: RefObject<HTMLTextAreaElement | null> | null;
  fileInputRef: RefObject<HTMLInputElement | null> | null;
  attachments: ComposerAttachment[];
  setAttachments: AttachmentSetter;
  removeAttachment: (id: string) => void;
  uploadingCount: number;
  addFiles: (files: FileList | null) => void;
  addProjectDocument: (document: ProjectDashboardDocument) => Promise<void>;
  modelMenuOpen: boolean;
  setModelMenuOpen: (open: boolean) => void;
  accessMenuOpen: boolean;
  setAccessMenuOpen: (open: boolean) => void;
  contextPopoverOpen: boolean;
  setContextPopoverOpen: (open: boolean) => void;
  accessMode: AccessMode;
  planMode: boolean;
  model: string;
  modelState: ComposerModelState;
  reasoning: ReasoningEffort;
  context: ContextDetailsView | null | undefined;
  models: AppModelSummary[];
  activeModel: AppModelSummary | null;
  availableReasoning: string[];
  popoverThemeClass: string;
  isSending: boolean;
  activeTurn: boolean;
  canStop: boolean;
  canSend: boolean;
  workers: WorkerActivitySummary[];
  submit: (event: FormEvent<HTMLFormElement> | KeyboardEventLike) => void;
  handleKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  focusDraftFromComposerChrome: (
    event: ReactPointerEvent<HTMLFormElement>,
  ) => void;
  handleAccessModeChange: (mode: AccessMode) => void;
  handlePlanModeChange: (checked: boolean) => void;
  applyServerPlanMode: (enabled: boolean) => void;
  handleModelChoice: (model: AppModelSummary) => void;
  handleReasoningChange: (effort: ReasoningEffort) => void;
  onStop: () => void;
  onOpenContext: () => void;
  openAttachmentPicker: () => void;
  setSnapshot: (snapshot: Partial<ComposerStore>) => void;
}
