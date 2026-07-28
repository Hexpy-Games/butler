/// <reference types="bun" />

import { expect, test } from "bun:test";
import type { ProgressRow } from "../types.ts";
import { semanticProgressRows } from "./progress-rows.ts";

test("summary progress excludes ephemeral model waiting state", () => {
  const rows: ProgressRow[] = [
    {
      id: "model-wait",
      kind: "message",
      state: "running",
      safe_label: "모델 응답을 기다리고 있습니다",
      bridge_phase: "model_round_waiting",
    },
    {
      id: "plan",
      kind: "message",
      state: "running",
      safe_label: "배포 범위와 순서를 확정했습니다",
    },
  ];

  expect(semanticProgressRows(rows).map((row) => row.id)).toEqual(["plan"]);
});
