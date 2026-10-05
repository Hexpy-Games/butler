import type { RefObject } from "react";
import { useButlerStore } from "@/app/store";
import { setAppCopyLanguage } from "@/app/copy";
import { messageContentText } from "@/app/messageContent";
import type { AppModelSummary } from "@/app/types";
import type { ComposerAttachment } from "@/components/conversation/hooks/useFileAttachments";
import { useComposerStore } from "@/components/conversation/composerStore";

// Proposal-only fixture: the real composer and app stores with in-memory actions, so the real
// product controls and menus work without a gateway or a provider. Nothing here is persisted.

export const PROJECT_ID = "__ds_composer_proposal__";

const models: AppModelSummary[] = [
  {
    provider_id: "local", provider_label: "Local", model_id: "review", model_ref: "local/review",
    display_name: "Review model", status: "available", runtime_supported: true,
    context_window_tokens: 128000, max_output_tokens: 8192, default_reasoning_effort: "medium",
    reasoning_efforts: ["low", "medium", "high"], token_estimator: "openai_tiktoken_o200k",
  },
  {
    provider_id: "local", provider_label: "Local", model_id: "review-fast", model_ref: "local/review-fast",
    display_name: "Review model fast", status: "available", runtime_supported: true,
    context_window_tokens: 64000, max_output_tokens: 8192, default_reasoning_effort: "low",
    reasoning_efforts: ["low", "medium"], token_estimator: "openai_tiktoken_o200k",
  },
];

export const proposalAttachment: ComposerAttachment = {
  id: "proposal-file", kind: "text",
  file: {
    file_id: "proposal-file", kind: "text", mime_type: "text/plain", safe_name: "notes.txt", size_bytes: 1280,
    sha256: "", url: "data:text/plain,Proposal%20notes", created_at: "2026-10-05T00:00:00Z",
  },
};

export const TYPING_TEXT = {
  "en-US": "Move the controls under the input.\nKeep every menu and the send button where they are.\nCheck 375px and desktop.",
  "ko-KR": "컨트롤을 입력창 아래로 옮겨 주세요.\n메뉴와 보내기 버튼은 그대로 둡니다.\n375px과 데스크톱에서 확인해 주세요.",
} as const;

export type ProposalLocale = keyof typeof TYPING_TEXT;

/** Installs the in-memory composer; returns a restore function. */
export function installComposerProposal(locale: ProposalLocale, fileInputRef: RefObject<HTMLInputElement | null>): () => void {
  const composer = useComposerStore.getState();
  const app = useButlerStore.getState();
  const originalFetch = window.fetch;
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname === `/projects/${PROJECT_ID}/dashboard/materials`) {
      return Response.json({
        data: {
          status: "ready", nextCursor: null,
          documents: [{
            id: "proposal-spec", kind: "spec", document_type: "spec", title: "Composer controls",
            safe_path_label: "spec/composer", markdown: "Keep the existing controls.", updated_at: "2026-10-05",
          }],
        },
      });
    }
    return originalFetch(input, init);
  }, originalFetch);
  const set = useComposerStore.setState;
  setAppCopyLanguage(locale);
  useButlerStore.setState({
    activeChatId: `dashboard:${PROJECT_ID}`, liveConnectionLost: false, agentNotice: null,
    projectWorkspaceKinds: { [PROJECT_ID]: "git" }, openSettings: () => {},
  });
  const setText = (text: string) => set({ text, canSend: Boolean(text.trim()), contentParts: undefined });
  set({
    draftSessionId: `dashboard:${PROJECT_ID}`, text: "", large: true, planMode: false, workspaceMode: "local",
    attachments: [], model: models[0].model_ref, activeModel: models[0], models, modelState: "ready",
    availableReasoning: models[0].reasoning_efforts, reasoning: "medium", accessMode: "ask_first",
    context: { provider_id: "local", model_ref: models[0].model_ref, used_tokens: 53760, budget_tokens: 128000, ratio: 0.42, categories: [] },
    canSend: false, canStop: true, activeTurn: false, isSending: false, uploadingCount: 0,
    fileInputRef,
    setText, setContentParts: (content) => setText(messageContentText(content)),
    handleAccessModeChange: (accessMode) => set({ accessMode }),
    handlePlanModeChange: (planMode) => set({ planMode }),
    handleModelChoice: (activeModel) => set({
      activeModel, model: activeModel.model_ref, availableReasoning: activeModel.reasoning_efforts, modelMenuOpen: false,
    }),
    addProjectDocument: async () => set({ attachments: [proposalAttachment] }),
    handleReasoningChange: (reasoning) => set({ reasoning }),
    removeAttachment: (id) => set({ attachments: useComposerStore.getState().attachments.filter((item) => item.id !== id) }),
    setAttachments: (value) => set({ attachments: typeof value === "function" ? value(useComposerStore.getState().attachments) : value }),
    openAttachmentPicker: () => set({ attachments: [proposalAttachment] }),
    submit: (event) => {
      event.preventDefault();
      set({ text: "", canSend: false, activeTurn: true });
    },
    onStop: () => set({ activeTurn: false }),
    modelMenuOpen: false, accessMenuOpen: false, contextPopoverOpen: false,
  });
  const followTheme = () => useButlerStore.setState({
    settings: { ...app.settings, appearance_theme: document.body.classList.contains("theme-dark") ? "dark" : "light" },
  });
  const themeObserver = new MutationObserver(followTheme);
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  followTheme();
  return () => {
    themeObserver.disconnect();
    window.fetch = originalFetch;
    set(composer, true);
    useButlerStore.setState(app, true);
  };
}
