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
import type { SessionSummaryView } from "@/app/types.ts";
import { MessageContent } from "./MessageContent";
import { useMessageList } from "./hooks/useMessageList";
import { useComposerState } from "./hooks/useComposerState";
import { ComposerToolbar } from "./ComposerToolbar";
import { useComposerStore } from "./composerStore";
import { anchoredStewardProgressByMessageId } from "./stewardParentProgressProjection";

test("active Steward progress is nested in its exact parent assistant row", () => {
  const progress = anchoredStewardProgressByMessageId(
    HARNESS_MESSAGES,
    HARNESS_SS03_SUMMARY,
  ).get("m4");
  expect(progress?.child.session_id).toBe("harness-steward");

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
  expect(html).toContain("Steward child · Validating the activity surface");
  expect(html).toContain("작업 중 · 2/3");
  expect(html.indexOf("최신 응답에는 캔버스 마크")).toBeLessThan(
    html.indexOf("steward-parent-progress"),
  );
  expect(html).not.toContain("assistant-terminal-status-row");
  expect(html).not.toContain("답변 완료");
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
