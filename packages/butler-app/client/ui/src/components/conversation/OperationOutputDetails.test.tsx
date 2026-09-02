/// <reference types="bun" />

import { expect, test } from "bun:test";
import { presentOperationOutput } from "./operationOutputPresentation";

test("basic file operation output hides raw receipts behind a concise result", () => {
  const raw = JSON.stringify({
    ok: true,
    effect: "workspace_file_edit",
    path: "src/games/word-chain/game-handler.ts",
    bytes: 8005,
    before_sha256: "before",
    after_sha256: "after",
    effect_receipt: { receipt_id: "private-receipt" },
  });

  expect(presentOperationOutput("edit_file", raw, true)).toEqual({
    kind: "summary",
    content: "수정 완료 · game-handler.ts · 8,005바이트",
  });
  expect(presentOperationOutput("edit_file", raw, false)).toEqual({
    kind: "summary",
    content: "결과 일부를 불러왔습니다. 전체 결과를 보려면 출력 더 보기를 선택하세요.",
  });
});

test("run_command output shows status and output without its private JSON envelope", () => {
  const raw = JSON.stringify({
    ok: true,
    command: "git status --short",
    cwd: "/private/worktree",
    exit_code: 0,
    timed_out: false,
    stdout: " M src/game.ts\n",
    stderr: "",
    effect_receipts: [{ receipt_id: "private-receipt" }],
  });

  expect(presentOperationOutput("run_command", raw, true)).toEqual({
    kind: "command",
    summary: "명령 완료 · 종료 코드 0",
    content: "M src/game.ts",
  });
});

test("unknown structured tool results never expose raw JSON", () => {
  expect(presentOperationOutput("custom_tool", JSON.stringify({
    ok: true,
    private_ref: "must-not-render",
  }), true)).toEqual({
    kind: "summary",
    content: "작업을 완료했습니다.",
  });
});

test("read_file output shows the file content instead of its JSON envelope", () => {
  expect(presentOperationOutput("read_file", JSON.stringify({
    ok: true,
    path: "src/game-handler.ts",
    content: "export const ready = true;\n",
  }), true)).toEqual({
    kind: "code",
    content: "export const ready = true;\n",
  });
});
