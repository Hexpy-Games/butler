/// <reference types="bun" />

import React from "react";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProgressRow } from "@/app/types.ts";
import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import { TurnActivityMessage } from "./TurnActivityMessage";

test("Steward activity renders in the main current-message slot beside accepted Plan rows", () => {
  const rows: ProgressRow[] = [{
    id: "steward-current-note",
    kind: "message",
    safe_label: "Steward child is validating the result",
    state: "running",
    created_at: "2026-08-19T00:02:30.000Z",
  }, {
    id: "steward-plan-action",
    kind: "todo",
    safe_label: "Write the bounded result",
    safe_input_label: "write-result",
    safe_order: 0,
    state: "pending",
    created_at: "2026-08-19T00:02:00.000Z",
  }];
  const virtualRow = {
    index: 0,
    start: 0,
    size: 120,
    end: 120,
    key: "0",
    lane: 0,
  } as VirtualItem;
  const rowVirtualizer = {
    measureElement: () => undefined,
  } as unknown as Virtualizer<HTMLDivElement, Element>;
  const html = renderToStaticMarkup(
    <TurnActivityMessage
      progressRows={rows}
      turnState="thinking"
      startedAt="2026-08-19T00:02:00.000Z"
      turnId="steward-turn"
      virtualRow={virtualRow}
      topOffset={0}
      rowVirtualizer={rowVirtualizer}
    />,
  );
  expect(html).toContain("turn-activity-message");
  expect(html).toContain("turn-current-status-slot");
  expect(html).toContain("Steward child is validating the result");
  expect(html).not.toContain("Write the bounded result");
});
