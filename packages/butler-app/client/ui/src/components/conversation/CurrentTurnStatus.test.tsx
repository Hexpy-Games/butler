/// <reference types="bun" />

import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProgressRow } from "@/app/types.ts";
import { CurrentTurnStatus } from "./CurrentTurnStatus";

test("current status reserves one clipped line with the public operation title", () => {
  const publicLabel = "실행: git commit";
  const html = renderToStaticMarkup(
    <CurrentTurnStatus operation={progressRow(publicLabel)} />,
  );

  expect(html).toContain('data-test-class="turn-current-status-slot"');
  expect(html).toContain('data-test-class="turn-current-status-content"');
  expect(html).toContain('data-test-class="assistant-status-label"');
  expect(html).toContain('data-test-class="assistant-status-mark-active"');
  expect(html).toContain(`title="${publicLabel}"`);
  expect(html).toContain(publicLabel);
});

test("model waiting and operation status share typography while waiting keeps local elapsed time", () => {
  const operationHtml = renderToStaticMarkup(
    <CurrentTurnStatus operation={progressRow("실행: 로그를 확인 중")} />,
  );
  const waitingHtml = renderToStaticMarkup(
    <CurrentTurnStatus modelRoundWait={{
      ...progressRow("응답 생성 중"),
      id: "model-round-wait",
      bridge_phase: "model_round_waiting",
      created_at: new Date(Date.now() - 3_000).toISOString(),
    }} />,
  );
  const operationStyle = operationHtml.match(
    /data-test-class="turn-phase-activity"[^>]*style="([^"]+)"/u,
  )?.[1];
  const waitingStyle = waitingHtml.match(
    /data-test-class="turn-model-round-waiting"[^>]*style="([^"]+)"/u,
  )?.[1];

  expect(waitingHtml).toContain("응답 생성 중");
  expect(waitingHtml).toMatch(/응답 생성 중 · 0분 [23]초/u);
  expect(waitingHtml).toContain('data-turn-state="running"');
  expect(operationStyle).toBeDefined();
  expect(waitingStyle).toBe(operationStyle);
});

function progressRow(label: string): ProgressRow {
  return {
    id: "operation-current-status",
    kind: "used_tool",
    state: "running",
    safe_label: label,
    safe_tool_name: "run_command",
    bridge_phase: "btcc_operation",
  };
}
