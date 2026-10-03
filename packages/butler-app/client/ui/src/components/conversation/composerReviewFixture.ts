import { useButlerStore } from "@/app/store";
import { getAppLocale, setAppCopyLanguage } from "@/app/copy";
import { messageContentText } from "@/app/messageContent";
import type { AppModelSummary } from "@/app/types";
import type { ComposerAttachment } from "./hooks/useFileAttachments";
import { useComposerStore } from "./composerStore";

const model: AppModelSummary = {
  provider_id: "local", provider_label: "Local", model_id: "review", model_ref: "local/review",
  display_name: "Review model", status: "available", runtime_supported: true,
  context_window_tokens: 128000, max_output_tokens: 8192, default_reasoning_effort: "medium",
  reasoning_efforts: ["low", "medium", "high"], token_estimator: "openai_tiktoken_o200k",
};
export const reviewAttachment: ComposerAttachment = {
  id: "review-file", kind: "text", file: { file_id: "review-file", kind: "text", mime_type: "text/plain",
    safe_name: "notes.txt", size_bytes: 128, sha256: "", url: "data:text/plain,Review%20notes", created_at: "2026-10-03T00:00:00Z" },
};

let reviewers = 0;
let restoreReview: (() => void) | undefined;
function releaseReview() {
  if (--reviewers === 0) { restoreReview?.(); restoreReview = undefined; }
}

/** Viewer-only in-memory actions: use the product controls without a gateway or provider. */
export function installComposerReview(locale: string) {
  if (reviewers++ > 0) return releaseReview;
  const composer = useComposerStore.getState();
  const app = useButlerStore.getState();
  const previousLocale = getAppLocale();
  const originalFetch = window.fetch;
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname === "/projects/__ds_composer_review__/dashboard/materials") return Response.json({ data: {
      status: "ready", nextCursor: null, documents: [{ id: "review-spec", kind: "spec", document_type: "spec",
        title: "Composer review", safe_path_label: "spec/compose", markdown: "Keep the existing controls.", updated_at: "2026-10-03" }],
    } });
    return originalFetch(input, init);
  }, originalFetch);
  const set = useComposerStore.setState;
  setAppCopyLanguage(locale);
  useButlerStore.setState({ activeChatId: "draft:chat", liveConnectionLost: false, agentNotice: null,
    projectWorkspaceKinds: { __ds_composer_review__: "git" }, openSettings: () => {} });
  const setText = (text: string) => set({ text, canSend: Boolean(text.trim()), contentParts: undefined });
  set({ draftSessionId: "dashboard:__ds_composer_review__", text: "", large: true, planMode: true, workspaceMode: "local",
    attachments: [], model: model.model_ref, activeModel: model, models: [model], modelState: "ready",
    availableReasoning: model.reasoning_efforts, reasoning: "medium", accessMode: "ask_first",
    context: { provider_id: "local", model_ref: model.model_ref, used_tokens: 53760, budget_tokens: 128000, ratio: 0.42, categories: [] },
    canSend: false, canStop: true, activeTurn: false, isSending: false,
    setText, setContentParts: (content) => setText(messageContentText(content)),
    handleAccessModeChange: (accessMode) => set({ accessMode }),
    handlePlanModeChange: (planMode) => set({ planMode }),
    handleModelChoice: (activeModel) => set({ activeModel, model: activeModel.model_ref, modelMenuOpen: false }),
    addProjectDocument: async () => set({ attachments: [reviewAttachment] }),
    handleReasoningChange: (reasoning) => set({ reasoning }),
    setAttachments: (value) => set({ attachments: typeof value === "function" ? value(useComposerStore.getState().attachments) : value }),
    submit: (event) => { event.preventDefault(); set({ text: "", canSend: false, activeTurn: true }); },
    onStop: () => set({ activeTurn: false }),
    modelMenuOpen: false, accessMenuOpen: false, contextPopoverOpen: false,
  });
  const followTheme = () => useButlerStore.setState({ settings: { ...app.settings,
    appearance_theme: document.body.classList.contains("theme-dark") ? "dark" : "light" } });
  const themeObserver = new MutationObserver(followTheme);
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  followTheme();
  restoreReview = () => { themeObserver.disconnect(); window.fetch = originalFetch; set(composer, true); useButlerStore.setState(app, true); setAppCopyLanguage(previousLocale); };
  return releaseReview;
}
