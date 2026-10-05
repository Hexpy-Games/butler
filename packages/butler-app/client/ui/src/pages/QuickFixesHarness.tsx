import { useEffect, useState } from "react";
import { AdaptiveShell, AdaptiveShellSidebar, AdaptiveShellWorkspace, Button, ButtonContainer, ComposerCard, Stack, Typo } from "@/butler-ds";
import { ComposerTextArea } from "@/components/conversation/ComposerTextArea";
import { useComposerStore } from "@/components/conversation/composerStore";
import { useComposerKeyboard } from "@/components/conversation/hooks/useComposerKeyboard";
import { useComposerSubmit } from "@/components/conversation/hooks/useComposerSubmit";
import { MessageContent } from "@/components/conversation/MessageContent";
import { SessionObserverDialog } from "@/components/layout/SessionObserverDialog";
import { ModelsSettings } from "@/components/settings/ModelsSettings";
import { useButlerStore } from "@/app/store";
import { useSettingsUIStore } from "@/stores/settingsUIStore";
import { setAppCopyLanguage } from "@/app/copy";
import { EMPTY_SETTINGS } from "@/app/constants";
import { HARNESS_MODEL_CATALOG, HARNESS_SS03_OBSERVER_VIEW } from "@/app/fixtures";
import { projectTurnActivity } from "@/app/conversation-progress";
import { appShellTheme } from "@/app/utils";
import { usePortalThemeClasses } from "@/hooks/usePortalThemeClasses";
import type { MessageRecord, ProgressRow } from "@/app/types";

// Public child progress containing the same block/tool facts as a conversation.
const rows: ProgressRow[] = [
  { id: "block-start", kind: "work_block", state: "running", safe_label: "자료 확인",
    work_block_id: "research", work_block_label: "자료 확인", work_block_phase: "started" },
  { id: "search", kind: "searched", state: "delivered", safe_label: "자료 검색",
    safe_tool_name: "search", safe_input_label: "설정 문서", tool_call_id: "search-call", work_block_id: "research" },
  { id: "command", kind: "ran_command", state: "delivered", safe_label: "검사 실행",
    safe_tool_name: "run_command", safe_input_label: "bun run check", tool_call_id: "command-call", work_block_id: "research" },
  { id: "block-end", kind: "work_block", state: "delivered", safe_label: "자료 확인",
    work_block_id: "research", work_block_label: "자료 확인", work_block_phase: "completed" },
];
const defaultMessage: MessageRecord = { id: "answer", chat_id: "steward-fixture", turn_id: "child-turn",
  role: "assistant", status: "delivered", text: "자료 검색과 검사를 마쳤습니다.",
  created_at: "2026-10-03T00:00:10Z", work_blocks: projectTurnActivity(rows, "child-turn").workBlocks };

/** Browser harness using product renderers and keyboard handlers; no provider calls. */
export function QuickFixesHarness() {
  const fixture = (window as Window & { butlerActivityFixture?: import("@/app/types").SessionView }).butlerActivityFixture;
  const activityRows = fixture?.latest_turn?.progress?.safe_progress_rows ?? rows;
  const message = fixture ? { ...defaultMessage, turn_activity_rows: activityRows,
    work_blocks: projectTurnActivity(activityRows, "child-turn").workBlocks } : defaultMessage;
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode") ?? "composer";
  const theme = params.get("theme") === "dark" ? "dark" : "light";
  const language = params.get("locale") === "en" ? "en" : "ko";
  const settings = { ...EMPTY_SETTINGS, appearance_theme: theme, language } as const;
  const [composing, setComposing] = useState(false);
  const [sent, setSent] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const text = useComposerStore(state => state.text);
  const submit = useComposerSubmit({ text, setText: useComposerStore.getState().setText,
    attachments: [], setAttachments: () => {}, isSending: false, activeTurn: false, uploadingCount: 0,
    model: "stub", reasoning: "none", accessMode: "full_access", planMode: false, controlsTouched: false,
    setModelMenuOpen: () => {}, setAccessMenuOpen: () => {},
    onSend: value => setSent(values => [...values, value]) });
  const keyboard = useComposerKeyboard({ isComposing: composing,
    multilineSendBehavior: params.get("send") ?? "modifier_enter_send_enter_newline",
    setModelMenuOpen: () => {}, setAccessMenuOpen: () => {},
    submit });
  usePortalThemeClasses(settings);
  useEffect(() => { useComposerStore.setState({ handleKeyDown: keyboard, setIsComposing: setComposing }); }, [keyboard]);
  useEffect(() => {
    setAppCopyLanguage(language);
    const turn = { ...HARNESS_SS03_OBSERVER_VIEW.latest_turn!, id: "child-turn",
      state: params.get("state") === "running" ? "running" : "delivered", progress: { safe_progress_rows: activityRows } };
    const session = { ...HARNESS_SS03_OBSERVER_VIEW, session_id: "steward-fixture",
      relation: { ...HARNESS_SS03_OBSERVER_VIEW.relation!, safe_title: fixture?.relation?.safe_title ?? "위임 작업" }, messages: [{ ...message, work_blocks: undefined }],
      latest_turn: turn, active_turn: turn.state === "running" ? turn : null };
    useButlerStore.setState({ settings, modelCatalog: HARNESS_MODEL_CATALOG,
      observerSessionId: null, sessionViews: { "steward-fixture": session }, refreshSessionObserver: async () => true });
    useSettingsUIStore.setState({ draft: settings, modelRoute: { page: "root" } });
    useComposerStore.setState({ text: "", draftSessionId: "quick-fixes", large: true });
    setReady(true);
  }, [language, theme]);
  return <AdaptiveShell leftOpen={false} rightOpen={false} theme={appShellTheme(settings)}>
    <AdaptiveShellSidebar open={false} />
    <AdaptiveShellWorkspace><Stack gap="md" data-harness-ready={ready}>
      {mode === "composer" ? <>
        <ComposerCard><ComposerTextArea /></ComposerCard>
        <Typo.Body data-submissions={JSON.stringify(sent)}>{sent.at(-1)}</Typo.Body>
      </> : mode === "settings" ? <ModelsSettings /> : <>
        <MessageContent message={message} copied={false} footerMeta={null} />
        <ButtonContainer size="sm"><Button size="sm" text="위임 작업" onClick={() =>
          useButlerStore.setState({ observerSessionId: "steward-fixture" })} /></ButtonContainer>
        <SessionObserverDialog />
      </>}
    </Stack></AdaptiveShellWorkspace>
  </AdaptiveShell>;
}
