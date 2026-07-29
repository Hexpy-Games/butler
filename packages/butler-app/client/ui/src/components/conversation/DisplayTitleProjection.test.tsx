/// <reference types="bun" />

import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProgressRow } from "@/app/types.ts";
import { TurnActivityPanel } from "./TurnActivityPanel";

const fullSummary =
  "Sandy 끝말잇기 릴리스 프로그램의 모든 규격과 작업 상태를 확인하고 다음 실행 범위를 확정했습니다.";

test("activity uses a compact title without discarding the full summary", () => {
  const html = render({ work_decision_title: "끝말잇기 범위 확정" });

  expect(html).toContain("끝말잇기 범위 확정");
  expect(html).toContain(fullSummary);
});

test("legacy activity compacts only its title", () => {
  const html = render({});

  expect(html).toContain("Sandy 끝말잇기 릴리스 프로그램의 모든 …");
  expect(html).toContain(fullSummary);
});

function render(extra: Partial<ProgressRow>): string {
  return renderToStaticMarkup(<TurnActivityPanel rows={[{
    id: "conception-activity",
    kind: "message",
    state: "running",
    safe_label: fullSummary,
    semantic_block_id: "conception_deliberation",
    work_decision_summary: fullSummary,
    work_decision_rationale: "사용자의 원래 목표를 보존하기 위해 필요합니다.",
    work_decision_next_step: "목표 계약을 작성합니다.",
    work_decision_source: "model-authored",
    ...extra,
  }]} state="running" />);
}
