/// <reference types="bun" />

import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EMPTY_MODEL_CATALOG,
  EMPTY_SETTINGS,
} from "@/app/constants.ts";
import {
  HARNESS_MESSAGES,
  HARNESS_SS03_SUMMARY,
} from "@/app/fixtures.ts";
import type { MessageRecord, SessionSummaryView } from "@/app/types.ts";
import { MessageContent } from "./MessageContent";
import { useMessageList } from "./hooks/useMessageList";
import { useComposerState } from "./hooks/useComposerState";
import { ComposerToolbar } from "./ComposerToolbar";
import { ComposerNotices } from "./ComposerNotices";
import { StewardComposerCapsules } from "./StewardComposerCapsules";
import { useComposerStore } from "./composerStore";
import { anchoredStewardProgressByMessageId } from "./stewardParentProgressProjection";

test("each active Steward has an ordered DS capsule with factual Plan progress", () => {
  const activeHtml = renderToStaticMarkup(
    <StewardComposerCapsules
      children={HARNESS_SS03_SUMMARY.steward_children ?? []}
    />,
  );
  expect(activeHtml).toContain('data-shape="pill"');
  expect(activeHtml).toContain('data-test-class="steward-progress-capsule"');
  expect(activeHtml).toContain('data-alignment="center"');
  expect(activeHtml).toContain('data-slot="button-icon"');
  expect(activeHtml).toContain("<canvas");
  expect(activeHtml).toContain('data-test-class="steward-capsule-task"');
  expect(activeHtml).toContain('data-test-class="steward-capsule-activity"');
  expect(activeHtml).toContain('data-test-class="steward-capsule-progress"');
  expect(activeHtml).toContain("Review the activity surface");
  expect(activeHtml).toContain("Validating the activity surface");
  expect(activeHtml).toContain(">2/3<");
  expect(activeHtml).not.toContain("작업 중 · 2/3");
  expect(activeHtml.indexOf('data-slot="button-icon"')).toBeLessThan(
    activeHtml.indexOf('data-test-class="steward-capsule-task"'),
  );
  expect(activeHtml.indexOf('data-test-class="steward-capsule-task"')).toBeLessThan(
    activeHtml.indexOf('data-test-class="steward-capsule-activity"'),
  );
  expect(activeHtml.indexOf('data-test-class="steward-capsule-activity"')).toBeLessThan(
    activeHtml.indexOf('data-test-class="steward-capsule-progress"'),
  );
  expect(activeHtml.match(/steward-progress-capsule/g)).toHaveLength(1);

  const second = structuredClone(HARNESS_SS03_SUMMARY.steward_children![0]!);
  second.session_id = "harness-steward-2";
  second.title = "Second active task";
  second.relation = {
    ...second.relation,
    relation_id: "harness-relation-2",
    child_session_id: second.session_id,
  };
  second.active_turn = {
    ...second.active_turn!,
    id: "harness-steward-turn-2",
    progress: {
      ...second.active_turn!.progress,
      summary: "Checking the second result",
      turn_id: "harness-steward-turn-2",
    },
  };
  const concurrentHtml = renderToStaticMarkup(
    <StewardComposerCapsules
      children={[HARNESS_SS03_SUMMARY.steward_children![0]!, second]}
    />,
  );
  expect(concurrentHtml.match(/steward-progress-capsule/g)).toHaveLength(2);
  expect(concurrentHtml).toContain("Validating the activity surface");
  expect(concurrentHtml).toContain("Checking the second result");

  const terminalChild = structuredClone(
    HARNESS_SS03_SUMMARY.steward_children![0]!,
  );
  terminalChild.status = "delivered";
  terminalChild.active_turn = null;
  expect(renderToStaticMarkup(
    <StewardComposerCapsules children={[terminalChild]} />,
  )).toBe("");

  const staleTerminalChild = structuredClone(
    HARNESS_SS03_SUMMARY.steward_children![0]!,
  );
  staleTerminalChild.active_turn = {
    ...staleTerminalChild.active_turn!,
    state: "delivered",
  };
  expect(renderToStaticMarkup(
    <StewardComposerCapsules children={[staleTerminalChild]} />,
  )).toBe("");

  const terminalSummary = {
    ...HARNESS_SS03_SUMMARY,
    turn_state: "delivered",
    latest_turn_subsession_result: {
      relation_id: "harness-relation",
      result_id: "harness-result",
      safe_title: "Review the activity surface",
    },
  } satisfies SessionSummaryView;
  expect(renderToStaticMarkup(
    <ComposerNotices summary={terminalSummary} />,
  )).not.toContain("steward-synthesis-capsule");
});

test("Steward result synthesis capsule reports preparation and offers no Stop", () => {
  const summary: SessionSummaryView = {
    ...HARNESS_SS03_SUMMARY,
    turn_state: "thinking",
    latest_turn_cancellable: false,
    latest_turn_subsession_result: {
      relation_id: "harness-relation",
      result_id: "harness-result",
      safe_title: "Review the activity surface",
    },
    latest_progress: {
      turn_id: "turn-synthesis",
      state: "thinking",
      summary: "Review the activity surface 작업에 대한 보고 준비 중",
      safe_progress_rows: [],
    },
  };
  const capsuleHtml = renderToStaticMarkup(
    <StewardComposerCapsules
      children={summary.steward_children ?? []}
      synthesis={summary.latest_turn_subsession_result}
    />,
  );
  expect(capsuleHtml).toContain(
    "Review the activity surface 작업에 대한 보고 준비 중",
  );
  expect(capsuleHtml).toContain('data-alignment="center"');
  expect(capsuleHtml).toContain("<canvas");

  const synthesisState = useComposerState(
    summary,
    {},
    EMPTY_SETTINGS,
    {
      ...EMPTY_MODEL_CATALOG,
      models: [{
        provider_id: "test",
        provider_label: "Test",
        model_id: "test",
        model_ref: "test/model",
        display_name: "Test",
        status: "available",
        default_reasoning_effort: "none",
        reasoning_efforts: ["none"],
        token_estimator: "none",
        runtime_supported: true,
      }],
    },
    "test/model",
    "ready",
    "",
    [],
    true,
    0,
  );
  expect(synthesisState.activeTurn).toBe(true);
  expect(synthesisState.canStop).toBe(false);

  useComposerStore.getState().setSnapshot({
    activeTurn: true,
    canStop: false,
    canSend: false,
    isSending: true,
  });
  const toolbar = renderToStaticMarkup(<ComposerToolbar />);
  expect(toolbar).not.toContain('aria-label="Stop"');
  expect(toolbar).toContain('aria-label="Send"');
});

test("active Steward progress is nested in its exact parent assistant row", () => {
  const progress = anchoredStewardProgressByMessageId(
    HARNESS_MESSAGES,
    HARNESS_SS03_SUMMARY,
  ).get("m4");
  expect(progress?.child.session_id).toBe("harness-steward");

  progress!.rows = [
    ...progress!.rows,
    {
      id: "steward-plan-operation",
      kind: "used_tool",
      state: "delivered",
      bridge_phase: "btcc_operation",
      safe_label: "실행 계획 수립",
      safe_tool_name: "replace_work_plan",
      tool_call_id: "plan-call",
    },
  ];

  const html = renderToStaticMarkup(
    <MessageContent
      message={HARNESS_MESSAGES.find((message) => message.id === "m4")!}
      copied={false}
      footerMeta={null}
      onCopyAssistantMessage={() => undefined}
      stewardProgress={progress}
    />,
  );

  expect(html).toContain("steward-parent-progress");
  expect(html).toContain("steward-message-content");
  expect(html).toContain("Review the activity surface");
  expect(html).toContain('title="Review the activity surface"');
  expect(html).toContain("작업 중 · 2/3");
  expect(html.indexOf("최신 응답에는 캔버스 마크")).toBeLessThan(
    html.indexOf("steward-parent-progress"),
  );
  expect(html).not.toContain("assistant-terminal-status-row");
  expect(html).not.toContain("답변 완료");
  expect(html).toContain('aria-label="진행 상세 보기"');
  expect(html).not.toContain(">진행 상세 보기<");
  expect(html).toContain("steward-tool-summary");
  expect(html).not.toContain("turn-work-tool-group");
  expect(html).not.toContain("aria-expanded");
  expect(html).toContain("2 검색");
  expect(html).not.toContain("실행 계획 수립");
  expect(html).not.toContain("turn-work-tool-row");
});

test("terminal Steward activity stays attached to the factual parent message", () => {
  const summary = structuredClone(HARNESS_SS03_SUMMARY) as SessionSummaryView;
  const child = summary.steward_children![0]!;
  child.status = "delivered";
  child.latest_turn = {
    ...child.active_turn!,
    state: "delivered",
    delivery_state: "delivered",
    cancellable: false,
    progress: {
      ...child.active_turn!.progress,
      state: "delivered",
    },
  };
  child.active_turn = null;

  const progress = anchoredStewardProgressByMessageId(
    HARNESS_MESSAGES,
    summary,
  ).get("m4");
  expect(progress?.turn.state).toBe("delivered");

  const html = renderToStaticMarkup(
    <MessageContent
      message={HARNESS_MESSAGES.find((message) => message.id === "m4")!}
      copied={false}
      footerMeta={null}
      onCopyAssistantMessage={() => undefined}
      stewardProgress={progress}
    />,
  );
  expect(html).toContain("steward-parent-progress-card");
  expect(html).toContain("Review the activity surface");
  expect(html).toContain("완료됨");
  expect(html).not.toContain("답변 완료");
});

test("two active Stewards attach to their own Butler messages", () => {
  const messages: MessageRecord[] = [
    ...HARNESS_MESSAGES,
    {
      id: "m5",
      chat_id: "butler-client",
      role: "user",
      text: "두 번째 조사를 진행해줘.",
      status: "sent",
      turn_id: "turn-3",
      cursor: 5,
      created_at: "2026-05-01T00:10:12.000Z",
      updated_at: "2026-05-01T00:10:12.000Z",
    },
    {
      id: "m6",
      chat_id: "butler-client",
      role: "assistant",
      text: "두 번째 Steward 조사도 시작했습니다.",
      status: "sent",
      turn_id: "turn-3",
      cursor: 6,
      created_at: "2026-05-01T00:10:42.000Z",
      updated_at: "2026-05-01T00:10:42.000Z",
    },
  ];
  const summary = structuredClone(HARNESS_SS03_SUMMARY) as SessionSummaryView;
  const first = summary.steward_children![0]!;
  summary.steward_children = [
    first,
    {
      ...first,
      session_id: "harness-steward-2",
      title: "Second bounded inspection",
      relation: {
        ...first.relation,
        relation_id: "harness-relation-2",
        parent_turn_id: "turn-3",
        child_session_id: "harness-steward-2",
        anchor_message_id: "m5",
        ordinal: 2,
      },
      active_turn: {
        ...first.active_turn!,
        id: "harness-steward-turn-2",
      },
    },
  ];

  const progress = anchoredStewardProgressByMessageId(messages, summary);
  expect([...progress.keys()]).toEqual(["m4", "m6"]);
  expect(progress.get("m4")?.child.session_id).toBe("harness-steward");
  expect(progress.get("m6")?.child.session_id).toBe("harness-steward-2");
});

test("missing, mismatched, and duplicate relation anchors fail closed", () => {
  const mismatched = structuredClone(HARNESS_SS03_SUMMARY) as SessionSummaryView;
  mismatched.steward_children![0]!.relation = {
    ...mismatched.steward_children![0]!.relation,
    anchor_message_id: "not-the-originating-message",
  };
  expect(
    anchoredStewardProgressByMessageId(HARNESS_MESSAGES, mismatched),
  ).toHaveLength(0);

  const mismatchedChat = structuredClone(HARNESS_SS03_SUMMARY) as SessionSummaryView;
  const anchor = HARNESS_MESSAGES.find((message) => message.id === "m3")!;
  const messagesWithMismatchedChat = HARNESS_MESSAGES.map((message) =>
    message === anchor ? { ...message, chat_id: "another-session" } : message,
  );
  expect(
    anchoredStewardProgressByMessageId(messagesWithMismatchedChat, mismatchedChat),
  ).toHaveLength(0);

  const mismatchedParentTurn = structuredClone(HARNESS_SS03_SUMMARY) as SessionSummaryView;
  mismatchedParentTurn.steward_children![0]!.relation = {
    ...mismatchedParentTurn.steward_children![0]!.relation,
    parent_turn_id: "not-the-parent-turn",
  };
  expect(
    anchoredStewardProgressByMessageId(HARNESS_MESSAGES, mismatchedParentTurn),
  ).toHaveLength(0);

  const duplicate = structuredClone(HARNESS_SS03_SUMMARY) as SessionSummaryView;
  const child = duplicate.steward_children![0]!;
  duplicate.steward_children = [
    child,
    {
      ...child,
      session_id: "harness-steward-2",
      relation: {
        ...child.relation,
        child_session_id: "harness-steward-2",
      },
    },
  ];
  expect(
    anchoredStewardProgressByMessageId(HARNESS_MESSAGES, duplicate),
  ).toHaveLength(0);
});

test("child progress does not add a standalone activity row or child Composer lock", () => {
  function MessageListProbe({ summary }: { summary: SessionSummaryView }) {
    const state = useMessageList(HARNESS_MESSAGES, summary, {}, false);
    return (
      <output
        data-item-count={state.itemCount}
        data-message-count={state.visibleMessages.length}
        data-show-activity={String(state.showTurnActivity)}
      />
    );
  }
  const listHtml = renderToStaticMarkup(<MessageListProbe summary={HARNESS_SS03_SUMMARY} />);
  expect(listHtml).toContain('data-item-count="4"');
  expect(listHtml).toContain('data-message-count="4"');
  expect(listHtml).toContain('data-show-activity="false"');
  const parentActiveSummary: SessionSummaryView = {
    ...HARNESS_SS03_SUMMARY,
    turn_state: "thinking",
    latest_progress: {
      turn_id: "turn-2",
      state: "thinking",
      safe_progress_rows: [{
        id: "parent-activity",
        kind: "message",
        state: "running",
        safe_label: "Butler is answering a separate request",
      }],
    },
  };
  const parentActiveHtml = renderToStaticMarkup(
    <MessageListProbe summary={parentActiveSummary} />,
  );
  expect(parentActiveHtml).toContain('data-item-count="5"');
  expect(parentActiveHtml).toContain('data-show-activity="true"');

  function ComposerStateProbe({ isSending }: { isSending: boolean }) {
    const parentSummary: SessionSummaryView = {
      ...HARNESS_SS03_SUMMARY,
      turn_state: "delivered",
      latest_progress: {
        state: "delivered",
        turn_id: "turn-2",
        safe_progress_rows: [],
      },
    };
    const state = useComposerState(
      parentSummary,
      {},
      EMPTY_SETTINGS,
      {
        ...EMPTY_MODEL_CATALOG,
        models: [{
          provider_id: "test",
          provider_label: "Test",
          model_id: "test",
          model_ref: "test/model",
          display_name: "Test",
          status: "available",
          default_reasoning_effort: "none",
          reasoning_efforts: ["none"],
          token_estimator: "none",
          runtime_supported: true,
        }],
      },
      "test/model",
      "ready",
      "draft response",
      [],
      isSending,
      0,
    );
    return <output data-can-send={String(state.canSend)} data-active={String(state.activeTurn)} />;
  }
  const composerHtml = renderToStaticMarkup(<ComposerStateProbe isSending={false} />);
  expect(composerHtml).toContain('data-can-send="true"');
  expect(composerHtml).toContain('data-active="false"');
  expect(renderToStaticMarkup(<ComposerStateProbe isSending />)).toContain('data-can-send="false"');

  useComposerStore.getState().setSnapshot({
    activeTurn: false,
    canSend: true,
    isSending: false,
  });
  expect(renderToStaticMarkup(<ComposerToolbar />)).toContain('aria-label="Send"');
  expect(renderToStaticMarkup(<ComposerToolbar />)).not.toContain('aria-label="Stop"');
});
