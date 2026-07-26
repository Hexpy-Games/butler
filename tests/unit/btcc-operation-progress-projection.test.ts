import { expect, test } from "bun:test";
import { projectSharedWorkBlocks } from
  "../../packages/butler-progress-projection/src/index.ts";
import type { SharedProgressRow } from
  "../../packages/butler-progress-projection/src/progress-projection-contract.ts";

test("BTCC phase operations do not create duplicate legacy work blocks", () => {
  const operation: SharedProgressRow = {
    id: "operation-read",
    kind: "used_tool",
    state: "completed",
    safe_label: "관련 구현 파일 확인",
    safe_tool_name: "read_workspace_files",
    tool_call_id: "request-read",
    semantic_block_id: "conception_deliberation",
    bridge_phase: "btcc_operation",
  };

  expect(projectSharedWorkBlocks([operation])).toEqual({
    blocks: [],
    issues: [],
  });
});
