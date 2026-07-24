/// <reference types="bun" />

import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnActivityLogPanel } from "./TurnActivityLogPanel";

test("turn activity log renders every committed public phase activity", () => {
  const html = renderToStaticMarkup(
    <TurnActivityLogPanel
      rows={[
        {
          id: "conception-1",
          kind: "message",
          state: "running",
          safe_label: "관련 기록을 확인하고 있습니다.",
          semantic_block_id: "conception_deliberation",
          work_decision_summary: "관련 기록을 확인하고 있습니다.",
          work_decision_rationale: "원래 목표를 정확히 보존하기 위해 필요합니다.",
          work_decision_next_step: "목표 계약을 작성합니다.",
          work_decision_source: "model-authored",
          created_at: "2026-07-24T03:00:00.000Z",
        },
        {
          id: "planning-1",
          kind: "message",
          state: "running",
          safe_label: "수정 범위를 정하고 있습니다.",
          semantic_block_id: "planning",
          work_decision_summary: "수정 범위를 정하고 있습니다.",
          work_decision_rationale: "작업 경계를 분명히 하기 위해 필요합니다.",
          work_decision_next_step: "계획을 독립적으로 검토합니다.",
          work_decision_source: "model-authored",
          created_at: "2026-07-24T03:01:00.000Z",
        },
        {
          id: "model-wait",
          kind: "message",
          state: "running",
          safe_label: "모델 응답을 기다리고 있습니다",
          semantic_block_id: "planning_review",
          bridge_phase: "model_round_waiting",
          created_at: "2026-07-24T03:02:00.000Z",
        },
      ]}
    />,
  );

  expect(html).toContain("턴 활동");
  expect(html).toContain("관련 기록을 확인하고 있습니다.");
  expect(html).toContain("원래 목표를 정확히 보존하기 위해 필요합니다.");
  expect(html).toContain("수정 범위를 정하고 있습니다.");
  expect(html).toContain("다음: 계획을 독립적으로 검토합니다.");
  expect(html).toContain("구상");
  expect(html).toContain("계획");
  expect(html).toContain("모델 응답을 기다리고 있습니다");
  expect(html).toContain("turn-model-round-waiting");
});
