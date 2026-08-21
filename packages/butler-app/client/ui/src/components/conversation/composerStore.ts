import type {
  Dispatch,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
  SetStateAction,
} from "react";
import { create } from "zustand";
import type {
  AccessMode,
  AppModelSummary,
  ComposerModelState,
  ContextDetailsView,
  ReasoningEffort,
  ProjectDashboardDocument,
  WorkerActivitySummary,
} from "@/app/types.ts";
import type { KeyboardEventLike } from "./hooks/composerEventTypes";
import type { ComposerAttachment } from "./hooks/useFileAttachments";
import { writeCachedComposerDraft } from "@/app/composerDraftCache.ts";

type AttachmentSetter = Dispatch<SetStateAction<ComposerAttachment[]>>;

interface ComposerStore {
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
  handleModelChoice: (model: AppModelSummary) => void;
  handleReasoningChange: (effort: ReasoningEffort) => void;
  onStop: () => void;
  onOpenContext: () => void;
  openAttachmentPicker: () => void;
  setSnapshot: (snapshot: Partial<ComposerStore>) => void;
}

const noop = () => {};
const noopAsync = async () => {};
const noopSubmit = (event: FormEvent<HTMLFormElement> | KeyboardEventLike) => {
  event.preventDefault();
};
const noopKeyDown = (_event: ReactKeyboardEvent<HTMLTextAreaElement>) => {};

export const useComposerStore = create<ComposerStore>((set, get) => ({
  draftRevision: 0,
  draftSessionId: "draft:chat",
  activateDraftSession: (draftSessionId, text) => {
    const draftRevision = get().draftRevision + 1;
    set({ draftRevision, draftSessionId, text });
    return draftRevision;
  },
  restoreDraftSession: ({ revision, sessionId, text }) => {
    const state = get();
    if (state.draftRevision !== revision || state.draftSessionId !== sessionId) {
      return false;
    }
    set({ text });
    return true;
  },
  engaged: false,
  setEngaged: (engaged) => set({ engaged }),
  text: "",
  setText: (text) => {
    const state = get();
    set({ draftRevision: state.draftRevision + 1, text });
    writeCachedComposerDraft(state.draftSessionId, text);
  },
  setIsComposing: noop,
  large: false,
  textAreaRef: null,
  fileInputRef: null,
  attachments: [],
  setAttachments: noop,
  removeAttachment: (id) =>
    get().setAttachments((current) =>
      current.filter((attachment) => attachment.id !== id),
    ),
  uploadingCount: 0,
  addFiles: noop,
  addProjectDocument: noopAsync,
  modelMenuOpen: false,
  setModelMenuOpen: (modelMenuOpen) => set({ modelMenuOpen }),
  accessMenuOpen: false,
  setAccessMenuOpen: (accessMenuOpen) => set({ accessMenuOpen }),
  contextPopoverOpen: false,
  setContextPopoverOpen: (contextPopoverOpen) => set({ contextPopoverOpen }),
  accessMode: "full_access",
  planMode: false,
  model: "",
  modelState: "loading",
  reasoning: "medium",
  context: null,
  models: [],
  activeModel: null,
  availableReasoning: ["none"],
  popoverThemeClass: "",
  isSending: false,
  activeTurn: false,
  canStop: false,
  canSend: false,
  workers: [],
  submit: noopSubmit,
  handleKeyDown: noopKeyDown,
  focusDraftFromComposerChrome: noop,
  handleAccessModeChange: noop,
  handlePlanModeChange: noop,
  handleModelChoice: noop,
  handleReasoningChange: noop,
  onStop: noop,
  onOpenContext: noop,
  openAttachmentPicker: () => get().fileInputRef?.current?.click(),
  setSnapshot: (snapshot) => set(snapshot),
}));
