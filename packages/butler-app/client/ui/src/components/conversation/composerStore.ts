import type {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { create } from "zustand";
import type { KeyboardEventLike } from "./hooks/composerEventTypes";
import { writeCachedComposerDraft } from "@/app/composerDraftCache.ts";
import type { ComposerStore } from "./composerStoreContract";

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
  featureDrawerOpen: false,
  setFeatureDrawerOpen: (featureDrawerOpen) => set({ featureDrawerOpen }),
  attachmentTriggerRef: null,
  setAttachmentTriggerRef: (attachmentTriggerRef) => set({ attachmentTriggerRef }),
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
  applyServerPlanMode: noop,
  handleModelChoice: noop,
  handleReasoningChange: noop,
  onStop: noop,
  onOpenContext: noop,
  openAttachmentPicker: () => get().fileInputRef?.current?.click(),
  setSnapshot: (snapshot) => set(snapshot),
}));
