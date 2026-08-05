/// <reference types="bun" />

import { expect, test } from "bun:test";
import { presentOperationOutput } from "./OperationOutputDetails";

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
    kind: "code",
    content: raw,
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
