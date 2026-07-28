/// <reference types="bun" />

import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProgressRow } from "@/app/types.ts";
import { CurrentTurnStatus } from "./CurrentTurnStatus";

test("current status reserves one clipped line with the public operation title", () => {
  const publicLabel = "실행: 로그를 확인 중";
  const html = renderToStaticMarkup(
    <CurrentTurnStatus operation={progressRow(publicLabel)} />,
  );

  expect(html).toContain('data-test-class="turn-current-status-slot"');
  expect(html).toContain('data-test-class="turn-current-status-content"');
  expect(html).toContain(`title="${publicLabel}"`);
  expect(html).toContain(publicLabel);
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
