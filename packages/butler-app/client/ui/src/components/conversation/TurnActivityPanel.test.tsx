/// <reference types="bun" />

import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProgressRow } from "@/app/types.ts";
import { TurnActivityPanel } from "./TurnActivityPanel";

test("turn activity panel renders opening decisions before work blocks", () => {
  const html = renderPanel([
    acknowledgedRow(),
    {
      id: "opening-decision",
      kind: "decision",
      state: "running",
      safe_label: "I will inspect the current UI read model.",
      public_decision_role: "opening",
      public_decision_summary: "I will inspect the current UI read model.",
      public_decision_rationale:
        "The panel must render explicit assistant decisions.",
      public_decision_next_step: "Check the focused client tests.",
      public_decision_source: "model-authored",
    },
    {
      id: "work-block",
      kind: "work_block",
      state: "running",
      safe_label: "Run focused validation",
      work_block_id: "work-validation",
      work_block_label: "Run focused validation",
    },
    {
      id: "tool-row",
      kind: "ran_command",
      state: "running",
      safe_label: "Bun: app-client utils",
      safe_tool_name: "Bun",
      safe_input_label: "app-client utils",
      tool_call_id: "tool-test",
      work_block_id: "work-validation",
      work_block_label: "Run focused validation",
    },
  ]);

  expect(html).toContain("turn-decision-row");
  expect(html).toContain("I will inspect the current UI read model.");
  expect(html).toContain("The panel must render explicit assistant decisions.");
  expect(html).toContain("Check the focused client tests.");
  expect(html.indexOf("turn-decision-row")).toBeLessThan(
    html.indexOf("Run focused validation"),
  );
  expect(html).toContain("Bun: app-client utils");
  expect(html).not.toContain("Request received. Preparing the work.");
});

test("turn activity panel keeps the latest phase activity visible after Opening", () => {
  const html = renderPanel([
    {
      id: "opening-decision",
      kind: "decision",
      state: "running",
      safe_label: "요청의 목표와 완료 조건을 정리하겠습니다.",
      public_decision_role: "opening",
      public_decision_summary: "요청의 목표와 완료 조건을 정리하겠습니다.",
      public_decision_rationale: "관리 작업이 필요합니다.",
      public_decision_next_step: "작업 계획을 세우겠습니다.",
      public_decision_source: "model-authored",
    },
    {
      id: "conception-progress",
      kind: "message",
      state: "running",
      safe_label: "요청의 의도와 목표를 구상하고 있습니다",
    },
    {
      id: "planning-progress",
      kind: "message",
      state: "running",
      safe_label: "작업 계획을 세우고 검토하고 있습니다",
    },
  ]);

  expect(html).toContain("turn-decision-row");
  expect(html).toContain("turn-phase-activity");
  expect(html).toContain("작업 계획을 세우고 검토하고 있습니다");
  expect(html).not.toContain("요청의 의도와 목표를 구상하고 있습니다");
});

test("turn activity panel shows model-authored phase intent as an open history", () => {
  const html = renderPanel([
    {
      id: "conception-activity",
      kind: "message",
      state: "running",
      safe_label: "관련 스펙과 구현을 확인하고 있습니다.",
      semantic_block_id: "conception_deliberation",
      work_decision_summary: "관련 스펙과 구현을 확인하고 있습니다.",
      work_decision_rationale: "사용자의 원래 목표를 보존하기 위해 필요합니다.",
      work_decision_next_step: "목표 계약을 작성합니다.",
      work_decision_source: "model-authored",
    },
    {
      id: "planning-activity",
      kind: "message",
      state: "running",
      safe_label: "수정 범위와 검증 경로를 정하고 있습니다.",
      semantic_block_id: "planning",
      work_decision_summary: "수정 범위와 검증 경로를 정하고 있습니다.",
      work_decision_rationale: "완결된 작업 단위로 나누기 위해 필요합니다.",
      work_decision_next_step: "계획 후보를 검토합니다.",
      work_decision_source: "model-authored",
    },
  ]);

  expect(html).toContain("작업 진행 로그");
  expect(html).toContain("2개 기록");
  expect(html).toContain("사용자의 원래 목표를 보존하기 위해 필요합니다.");
  expect(html).toContain("다음: 계획 후보를 검토합니다.");
  expect(html).toContain("aria-expanded=\"true\"");
});

test("turn activity panel renders acknowledged receipt only as pending status", () => {
  const html = renderPanel([acknowledgedRow()], "accepted");

  expect(html).toContain("turn-activity-pending");
  expect(html).toContain("Request received. Preparing the work.");
  expect(html).not.toContain("turn-decision-row");
  expect(html).not.toContain("turn-work-block");
});

test("turn activity panel keeps decision text out of tool controls", () => {
  const unsafeToolLabel = "I will inspect the opening decision path.";
  const html = renderPanel([
    {
      id: "work-block",
      kind: "work_block",
      state: "running",
      safe_label: "Run focused validation",
      work_block_id: "work-validation",
      work_block_label: "Run focused validation",
    },
    {
      id: "tool-row",
      kind: "ran_command",
      state: "running",
      safe_label: unsafeToolLabel,
      safe_tool_name: "Bash",
      tool_call_id: "tool-test",
      work_block_id: "work-validation",
      work_block_label: "Run focused validation",
    },
  ]);

  expect(html).toContain("Bash");
  expect(html).not.toContain(unsafeToolLabel);
});

function renderPanel(rows: ProgressRow[], state = "running"): string {
  return renderToStaticMarkup(<TurnActivityPanel rows={rows} state={state} />);
}

function acknowledgedRow(): ProgressRow {
  return {
    id: "ack-row",
    kind: "turn",
    state: "accepted",
    safe_label: "Request received. Preparing the work.",
    receipt_kind: "turn.acknowledged",
    work_block_id: "work-ack",
    work_block_label: "Receipt text must not become a block.",
  };
}
