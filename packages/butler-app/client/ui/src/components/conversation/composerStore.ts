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
  ContextDetailsView,
  ReasoningEffort,
  ProjectDashboardDocument,
  WorkerActivitySummary,
} from "@/app/types.ts";
import type { KeyboardEventLike } from "./hooks/composerEventTypes";
import type { ComposerAttachment } from "./hooks/useFileAttachments";

type AttachmentSetter = Dispatch<SetStateAction<ComposerAttachment[]>>;

interface ComposerStore {
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
  reasoning: ReasoningEffort;
  context: ContextDetailsView | null | undefined;
  models: AppModelSummary[];
  activeModel: AppModelSummary | null;
  availableReasoning: string[];
  popoverThemeClass: string;
  isSending: boolean;
  activeTurn: boolean;
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
  engaged: false,
  setEngaged: (engaged) => set({ engaged }),
  text: "",
  setText: (text) => set({ text }),
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
  reasoning: "medium",
  context: null,
  models: [],
  activeModel: null,
  availableReasoning: ["none"],
  popoverThemeClass: "",
  isSending: false,
  activeTurn: false,
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
