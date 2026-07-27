/// <reference types="bun" />

import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProgressRow } from "@/app/types.ts";
import { CurrentTurnStatus } from "./CurrentTurnStatus";

test("current status reserves one clipped line while preserving the full label", () => {
  const label = "Inspect a deliberately long operation title without moving the conversation";
  const html = renderToStaticMarkup(
    <CurrentTurnStatus operation={progressRow(label)} />,
  );

  expect(html).toContain('data-test-class="turn-current-status-slot"');
  expect(html).toContain('data-test-class="turn-current-status-content"');
  expect(html).toContain(`title="${label}"`);
  expect(html).toContain(label);

});

function progressRow(label: string): ProgressRow {
  return {
    id: "operation-current-status",
    kind: "used_tool",
    state: "running",
    safe_label: label,
    bridge_phase: "btcc_operation",
  };
}
