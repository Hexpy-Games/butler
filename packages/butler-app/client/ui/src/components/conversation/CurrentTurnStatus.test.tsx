/// <reference types="bun" />

import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProgressRow } from "@/app/types.ts";
import { CurrentTurnStatus } from "./CurrentTurnStatus";

test("current status reserves one clipped line with a capability-owned title", () => {
  const rawLabel = "run_command: printf a private argument";
  const html = renderToStaticMarkup(
    <CurrentTurnStatus operation={progressRow(rawLabel)} />,
  );

  expect(html).toContain('data-test-class="turn-current-status-slot"');
  expect(html).toContain('data-test-class="turn-current-status-content"');
  expect(html).toContain('title="실행: 계획한 작업을 처리 중"');
  expect(html).toContain("실행: 계획한 작업을 처리 중");
  expect(html).not.toContain(rawLabel);
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
