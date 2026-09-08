import { expect, test } from "bun:test";
import { projectSharedWorkBlocks } from
  "../../packages/butler-progress-projection/src/index.ts";
import { publicOperationTitle } from
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

test("BTCC operation titles come from typed capability metadata", () => {
  expect(publicOperationTitle("run_command", "ko-KR")).toBe(
    "명령 실행",
  );
  expect(publicOperationTitle("edit_file", "ko-KR")).toBe(
    "수정: 계획한 파일 변경을 적용 중",
  );
  expect(publicOperationTitle("read_operation_result", "ko-KR")).toBe(
    "확인: 저장된 작업 결과를 검토 중",
  );
  expect(publicOperationTitle("unknown-capability", "ko-KR")).toBe(
    "작업: 계획한 도구를 사용 중",
  );
  expect(publicOperationTitle("run_command")).toBe("Running command");
  expect(publicOperationTitle("unknown-capability", "en-US")).toBe("Working: using the planned tool");
});
