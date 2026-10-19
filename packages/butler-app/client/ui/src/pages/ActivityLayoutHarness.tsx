import { useEffect, useMemo, useState } from "react";
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
import type { MessageRecord, SessionView } from "@/app/types";
import { answer, changedFiles, decisionRows, defaultRows, noRows, roundOne, roundTwoRows, segmentOne } from "./activityLayoutFixtures";

/**
 * Deterministic stub stream through the product's virtual list and observer renderer.
 * `delta=wait` holds the first text delta, `rounds=2` replaces round-one text with round two,
 * `answer=none` never streams text, `tools=0` streams a turn without activity, `rows=decision`
 * streams a decision row, `segments=2` delivers a first segment before the streaming one, and
 * `settle=progress-first|message-first` settles the progress and the message 400ms apart, with
 * the streaming message carrying no activity rows of its own (as a gateway draft does).
 * `status=retrying` streams with that in-progress status, `final=empty` delivers the last
 * segment with no activity rows of its own (`[]`), and `files=1` streams with a changed file.
 */
export function ActivityLayoutHarness() {
  useAppLocale();
  const fixture = (window as Window & { butlerActivityFixture?: SessionView }).butlerActivityFixture;
  const params = new URLSearchParams(window.location.search);
  const rounds = params.get("rounds") === "2" ? 2 : 1;
  const noText = params.get("answer") === "none";
  const segments = params.get("segments") === "2";
  const settle = params.get("settle");
  const liveStatus = params.get("status") ?? "streaming";
  const finalRows = params.get("final") === "empty" ? noRows : undefined;
  const [running, setProgressLive] = useState(params.get("state") !== "completed");
  const [streaming, setMessageLive] = useState(running);
  const [round, setRound] = useState(1);
  const [length, setLength] = useState(params.get("delta") === "wait" || noText || segments ? 0 : 16);
  const baseRows = params.get("tools") === "0" ? noRows : params.get("rows") === "decision" ? decisionRows
    : fixture?.latest_turn?.progress?.safe_progress_rows ?? defaultRows;
  const rows = useMemo(() => round === 2 ? [...baseRows, ...roundTwoRows] : baseRows, [baseRows, round]);
  const roundText = rounds === 2 && round === 1 ? roundOne : answer;
  const started = length > 0;
  const roundDone = length === roundText.length;
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
  }, [running, rows]);
  useEffect(() => {
    if (!streaming || !started) return;
    if (roundDone && round < rounds) {
      const next = window.setTimeout(() => { setRound(round + 1); setLength(16); }, 400);
      return () => window.clearTimeout(next);
    }
    const end = roundText.length;
    const timer = window.setInterval(() => setLength((value) => Math.min(end, value + 16)), 80);
    return () => window.clearInterval(timer);
  }, [streaming, started, roundDone, round, rounds, roundText.length]);
  const complete = () => {
    const [first, second] = settle === "message-first" ? [setMessageLive, setProgressLive] : [setProgressLive, setMessageLive];
    first(false);
    if (settle) window.setTimeout(() => second(false), 400); else second(false);
  };
  const finalText = noText ? "" : answer;
  const messages: MessageRecord[] = Array.from({ length: count }, (_, index) => ({
    ...HARNESS_MESSAGES.find((message) => message.role === "assistant")!,
    id: `activity-layout-${index}`, chat_id: "activity-layout", turn_id: `activity-layout-${index}`,
    status: streaming ? liveStatus : "delivered", text: count > 1 ? "확인한 활동을 답변과 함께 표시합니다.\n\n".repeat(2) : streaming ? roundText.slice(0, length) : finalText,
    created_at: "2026-10-03T00:00:02.000Z", updated_at: "2026-10-03T00:00:09.000Z",
    turn_activity_rows: finalRows ?? (settle && streaming ? undefined : rows), changed_files: params.get("files") === "1" ? changedFiles : undefined, work_blocks: fixture ? completedWorkBlocks({ state: "delivered", safe_progress_rows: rows }) : undefined, artifacts: [], attachments: [],
  }));
  if (count === 1) messages.unshift({ ...messages[0]!, id: "previous-answer", turn_id: "previous-turn",
    status: "delivered", text: "이전 답변을 확인했습니다.\n\n".repeat(60), turn_activity_rows: undefined, changed_files: undefined });
  if (segments) messages.splice(-1, 0, { ...messages.at(-1)!, id: "activity-layout-segment-1", status: "delivered", text: segmentOne, turn_activity_rows: rows, changed_files: undefined });
  // Before the first delta the turn has no message yet; its activity renders as its own row.
  if (streaming && length === 0) messages.pop();
  const turn = { ...HARNESS_SS03_OBSERVER_VIEW.latest_turn!, id: "activity-layout-0",
    state: running ? "running" : "delivered", progress: { safe_progress_rows: rows } };
  const approvalFixture = (window as Window & { butlerApprovalFixture?: unknown }).butlerApprovalFixture;
  const approval = normalizeApprovalSummary(approvalFixture ?? { action_kind: "other", count: 1, risk: "low",
    targets: [{ kind: "folder", path: "C:\\Users\\test\\Downloads" }], examples: ["C:\\Users\\test\\Downloads"],
    operation: { tool: "list_files", access: "read_only", targets: ["C:\\Users\\test\\Downloads"] } });
  const decision = approvalRequestView({ approval, reason: (window as Window & { butlerApprovalReason?: string }).butlerApprovalReason ?? "", scope: undefined }, appCopy.interfaceTemplates.approvalRequest, appCopy.guided.tools);
  const canOpenTab = params.get("browser") === "1";
  const handoff = browserHandoffView({ approval }, appCopy.interfaceTemplates.approvalRequest, canOpenTab);
  return (
    <AdaptiveShell leftOpen={false} rightOpen={false} theme={appShellTheme(settings)}>
      <AdaptiveShellSidebar open={false} />
      <AdaptiveShellWorkspace><Stack fill gap="md" data-stub-stream-complete={round === rounds && length === roundText.length}>
      {params.get("approval") === "1" ? <ComposerCard><ComposerAuthorityDecisionSurface decision={{ ...decision, ...handoff,
        ...(handoff ? { handoff: { canOpenTab, signIn: handoff.signIn, onOpenTab: () => {}, onStop: () => {} } } : {}),
        pending: false, pendingCount: 1, scope: undefined, composingMessage: false,
        onAllow: async () => {}, onAllowConversation: async () => {}, onDeny: async () => {},
        onShowDecision: () => {}, onOpenSource: () => {}, onComposeMessage: () => {},
      }} /></ComposerCard> : null}
      <ButtonContainer size="sm">
        <Button size="sm" text="완료" onClick={complete} />
        {streaming && length === 0 && !noText ? <Button size="sm" text="답변 시작" onClick={() => setLength(16)} /> : null}
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
