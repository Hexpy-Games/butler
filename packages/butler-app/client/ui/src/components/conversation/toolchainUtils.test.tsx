/// <reference types="bun" />

import { expect, test } from "bun:test";
import type { ProgressRow } from "@/app/types.ts";
import {
  toolchainGroupLabel,
  toolchainSummaryLabel,
} from "./toolchainUtils";

test("BTCC basic file operations keep specific labels and group names", () => {
  const edit = operation("edit_file", "수정: game-handler.ts");
  const read = operation("read_file", "읽기: game-handler.ts");

  expect(toolchainSummaryLabel(edit)).toBe("수정: game-handler.ts");
  expect(toolchainGroupLabel(edit)).toBe("편집");
  expect(toolchainSummaryLabel(read)).toBe("읽기: game-handler.ts");
  expect(toolchainGroupLabel(read)).toBe("조회");
});

function operation(toolName: string, safeLabel: string): ProgressRow {
  return {
    id: `${toolName}-operation`,
    kind: "used_tool",
    state: "completed",
    safe_label: safeLabel,
    safe_tool_name: toolName,
    bridge_phase: "btcc_operation",
  };
}
