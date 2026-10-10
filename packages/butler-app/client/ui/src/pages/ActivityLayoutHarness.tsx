import { useEffect, useState } from "react";
import { AdaptiveShell, AdaptiveShellSidebar, AdaptiveShellWorkspace, Button, ButtonContainer, ComposerCard, ConversationShell, Dialog, DialogContent, DialogTitle, Stack } from "@/butler-ds";
import { completedWorkBlocks } from "@/app/conversation-progress/terminal-activity";
import { MessageList } from "@/components/conversation/MessageList";
import { SessionObserverTimeline } from "@/components/layout/SessionObserverTimeline";
import { ComposerAuthorityDecisionSurface } from "@/components/conversation/ComposerAuthorityDecisionSurface";
import { normalizeApprovalSummary, approvalRequestView, browserHandoffView } from "@/app/approvalRequest";
import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { setAppCopyLanguage } from "@/app/copy";
import { usePortalThemeClasses } from "@/hooks/usePortalThemeClasses";
import { appShellTheme } from "@/app/utils";
import { EMPTY_SETTINGS } from "@/app/constants";
import { HARNESS_MESSAGES, HARNESS_SS03_OBSERVER_VIEW } from "@/app/fixtures";
import type { MessageRecord, ProgressRow, SessionView } from "@/app/types";

const defaultRows: ProgressRow[] = [{
  id: "activity-layout-read", kind: "message", state: "delivered",
  semantic_block_id: "activity-layout-step", work_decision_source: "model-authored",
  work_decision_summary: "활동 화면 확인", safe_label: "활동 화면 확인",
  created_at: "2026-10-03T00:00:01.000Z",
}, {
  id: "files-start", kind: "work_block", state: "running", safe_label: "파일 확인",
  work_block_id: "files", work_block_label: "파일 확인", work_block_phase: "started",
  created_at: "2026-10-03T00:00:01.050Z",
}, {
  id: "listing", kind: "searched", state: "delivered", safe_label: "파일 목록 확인",
  safe_tool_name: "list_files", safe_input_label: "C:\\Users\\test\\Downloads", tool_call_id: "listing-call",
  work_block_id: "files", semantic_block_id: "activity-layout-step", bridge_phase: "btcc_operation",
  created_at: "2026-10-03T00:00:01.100Z",
}, {
  id: "reading", kind: "read", state: "delivered", safe_label: "파일 읽기",
  safe_tool_name: "read_file", safe_input_label: "보고서.txt", tool_call_id: "reading-call",
  work_block_id: "files", semantic_block_id: "activity-layout-step", bridge_phase: "btcc_operation",
  interface_content: { title: { key: "toolTitle", parameters: { toolName: "read_file", target: "보고서.txt" } } },
  created_at: "2026-10-03T00:00:01.200Z",
}, {
  id: "files-end", kind: "work_block", state: "delivered", safe_label: "파일 확인",
  work_block_id: "files", work_block_label: "파일 확인", work_block_phase: "completed",
  created_at: "2026-10-03T00:00:01.250Z",
}];
const answer = "확인한 활동을 답변과 함께 표시합니다.\n\n".repeat(8);

/** Deterministic stub stream through the product's virtual list and observer renderer. */
export function ActivityLayoutHarness() {
  useAppLocale();
  const fixture = (window as Window & { butlerActivityFixture?: SessionView }).butlerActivityFixture;
  const rows = fixture?.latest_turn?.progress?.safe_progress_rows ?? defaultRows;
  const params = new URLSearchParams(window.location.search);
  const [running, setRunning] = useState(params.get("state") !== "completed");
  const [length, setLength] = useState(16);
  const [observer, setObserver] = useState(params.get("observer") === "1");
  const count = params.get("list") === "1" ? 4 : 1;
  const theme = params.get("theme") === "dark" ? "dark" : "light";
  const language = params.get("lang") === "en" ? "en" : "ko";
  const settings = { ...EMPTY_SETTINGS, appearance_theme: theme, language } as const;
  usePortalThemeClasses(settings);
  useEffect(() => {
    setAppCopyLanguage(language);
    useButlerStore.setState({ activeChatId: "activity-layout", settings: {
      ...EMPTY_SETTINGS, language, appearance_theme: theme,
    } });
  }, [theme, language]);
  useEffect(() => {
    useButlerStore.setState({ summary: { session_id: "activity-layout", turn_state: running ? "running" : "delivered",
      latest_progress: { turn_id: "activity-layout-0", state: running ? "running" : "delivered", safe_progress_rows: rows } } });
    if (!running) return;
    const timer = window.setInterval(() => setLength((value) => Math.min(answer.length, value + 16)), 80);
    return () => window.clearInterval(timer);
  }, [running]);
  const messages: MessageRecord[] = Array.from({ length: count }, (_, index) => ({
    ...HARNESS_MESSAGES.find((message) => message.role === "assistant")!,
    id: `activity-layout-${index}`, chat_id: "activity-layout", turn_id: `activity-layout-${index}`,
    status: running ? "streaming" : "delivered", text: count > 1 ? "확인한 활동을 답변과 함께 표시합니다.\n\n".repeat(2) : running ? answer.slice(0, length) : answer,
    created_at: "2026-10-03T00:00:02.000Z", updated_at: "2026-10-03T00:00:09.000Z",
    turn_activity_rows: rows, work_blocks: fixture ? completedWorkBlocks({ state: "delivered", safe_progress_rows: rows }) : undefined, artifacts: [], attachments: [],
  }));
  if (count === 1) messages.unshift({ ...messages[0]!, id: "previous-answer", turn_id: "previous-turn",
    status: "delivered", text: "이전 답변을 확인했습니다.\n\n".repeat(60), turn_activity_rows: undefined });
  const turn = { ...HARNESS_SS03_OBSERVER_VIEW.latest_turn!, id: "activity-layout-0",
    state: running ? "running" : "delivered", progress: { safe_progress_rows: rows } };
  const approvalFixture = (window as Window & { butlerApprovalFixture?: unknown }).butlerApprovalFixture;
  const approval = normalizeApprovalSummary(approvalFixture ?? { action_kind: "other", count: 1, risk: "low",
    targets: [{ kind: "folder", path: "C:\\Users\\test\\Downloads" }], examples: ["C:\\Users\\test\\Downloads"],
    operation: { tool: "list_files", access: "read_only", targets: ["C:\\Users\\test\\Downloads"] } });
  const decision = approvalRequestView({ approval, reason: "", scope: undefined }, appCopy.interfaceTemplates.approvalRequest, appCopy.guided.tools);
  const canOpenTab = params.get("browser") === "1";
  const handoff = browserHandoffView({ approval }, appCopy.interfaceTemplates.approvalRequest, canOpenTab);
  return (
    <AdaptiveShell leftOpen={false} rightOpen={false} theme={appShellTheme(settings)}>
      <AdaptiveShellSidebar open={false} />
      <AdaptiveShellWorkspace><Stack fill gap="md" data-stub-stream-complete={length === answer.length}>
      {params.get("approval") === "1" ? <ComposerCard><ComposerAuthorityDecisionSurface decision={{ ...decision, ...handoff,
        ...(handoff ? { handoff: { canOpenTab, signIn: handoff.signIn, onOpenTab: () => {}, onStop: () => {} } } : {}),
        pending: false, pendingCount: 1, scope: undefined, composingMessage: false,
        onAllow: async () => {}, onAllowConversation: async () => {}, onDeny: async () => {},
        onShowDecision: () => {}, onOpenSource: () => {}, onComposeMessage: () => {},
      }} /></ComposerCard> : null}
      <ButtonContainer size="sm">
        <Button size="sm" text="완료" onClick={() => setRunning(false)} />
        <Button size="sm" text="작업 기록" onClick={() => setObserver(true)} />
      </ButtonContainer>
      <ConversationShell composerReserve={0}>
        <MessageList messages={messages} turnProgress={{}} bottomReserve={0} isSending={running} />
      </ConversationShell>
      <Dialog open={observer} onOpenChange={setObserver}>
        <DialogContent closeLabel="닫기" aria-describedby={undefined} data-test-class="activity-layout-observer">
          <DialogTitle>활동 화면 확인</DialogTitle>
          <SessionObserverTimeline messages={[{ ...messages.at(-1)!, turn_activity_rows: undefined }]}
            latestTurn={turn} activeTurn={running ? turn : null} />
        </DialogContent>
      </Dialog>
      </Stack></AdaptiveShellWorkspace>
    </AdaptiveShell>
  );
}
