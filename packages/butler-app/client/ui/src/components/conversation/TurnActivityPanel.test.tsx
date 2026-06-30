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
