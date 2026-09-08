/// <reference types="bun" />

import { afterEach, beforeEach, expect, test } from "bun:test";
import { setAppCopyLanguage } from "@/app/copy.ts";
beforeEach(() => setAppCopyLanguage("ko"));
afterEach(() => setAppCopyLanguage("en"));
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
    content: "도구 실행은 완료됐지만 상세 결과 표시를 지원하지 않습니다.",
  });
});

test("public text in catalog, memory, web, image and MCP results is not replaced by completion fallback", () => {
  const cases = [
    ["tool_describe", { ok: true, descriptions: [{ name: "read_file", description: "Read selected source files", schema: { properties: { requests: { type: "array" } } } }] }, "Read selected source files"],
    ["query_memory", { ok: true, results: [{ title: "Deployment", content: "Use the project deployment script." }] }, "Use the project deployment script."],
    ["read_mcp_resource", { ok: true, result: { contents: [{ text: "Resource body from MCP", mimeType: "text/plain" }] } }, "Resource body from MCP"],
    ["transform_public_data_table", { ok: true, title: "표", csv_preview: "name,value\nfirst,3", row_count: 60, columns: ["name", "value"], artifact_label: "data.csv" }, "60행 · 2열 · data.csv"],
    ["read_tool_output_artifact", { ok: true, stdout: { text: "Detailed command output" }, stderr: { text: "" } }, "Detailed command output"],
    ["web_read", { ok: true, title: "Source", markdown: "The complete source text." }, "The complete source text."],
    ["analyze_attached_image", { ok: true, analysis: "The chart rises in June." }, "The chart rises in June."],
    ["call_mcp_tool", { ok: false, error: { code: "mcp_tool_failed", message: "Choose an existing table." }, result: { isError: true, content: [{ type: "text", text: "Choose an existing table." }] } }, "Choose an existing table."],
  ] as const;
  for (const [tool, value, expected] of cases) {
    const result = JSON.stringify(presentOperationOutput(tool, JSON.stringify(value), true));
    expect(result).toContain(expected);
    expect(result).not.toContain("상세 결과 표시를 지원하지 않습니다");
  }
  expect(JSON.stringify(presentOperationOutput("custom_tool", JSON.stringify({ ok: true, pending: true }), true))).not.toContain("완료");
});

test("canonical batch reads show file bodies and individual failures without raw receipts", () => {
  expect(presentOperationOutput("read_file", JSON.stringify({
    ok: true,
    files: [
      { ok: true, path: "src/game-handler.ts", start_line: 1, end_line: 1, content: "export const ready = true;\n", sha256: "private-hash" },
      { ok: false, path: "missing.ts", error: "not_found" },
    ],
    evidence_receipts: [{ receipt_id: "private-receipt" }],
  }), true)).toEqual({
    kind: "sections", summary: "파일 읽기 · 1/2개",
    sections: [
      { title: "src/game-handler.ts · 1줄", content: "export const ready = true;\n", message: undefined },
      { title: "missing.ts", message: "파일을 찾을 수 없습니다." },
    ],
  });
});

test("read paging distinguishes deferred files from failed reads", () => {
  const output = presentOperationOutput("read_file", JSON.stringify({
    ok: true, truncated: true, files: [
      { ok: true, path: "a.ts", content: "abc", truncated: true },
      { ok: true, path: "b.ts", skipped: true, pending: true, content: "" },
    ],
  }), true);
  expect(output.kind).toBe("sections");
  expect(JSON.stringify(output)).toContain("아직 읽지 않았습니다");
  expect(JSON.stringify(output)).not.toContain("실패");
});

test("discovery and search outputs show their actual paths and matches", () => {
  expect(presentOperationOutput("list_files", JSON.stringify({ ok: true, files: [{ path: "src/main.ts", bytes: 24 }] }), true)).toEqual({
    kind: "sections", summary: "파일 목록 · 1개",
    sections: [{ title: "src/main.ts", message: "24바이트" }],
  });
  expect(presentOperationOutput("grep_files", JSON.stringify({ ok: true, matches: [{ path: "src/main.ts", line: 7, text: "const enabled = true;" }] }), true)).toEqual({
    kind: "sections", summary: "검색 결과 · 1건",
    sections: [{ title: "src/main.ts · 7줄", content: "const enabled = true;" }],
  });
});

test("Ledger results show public document metadata but not paths or internal references", () => {
  expect(presentOperationOutput("project_ledger_list", JSON.stringify({ ok: true, data: { results: [
    { title: "호출 통합 계획", kind: "plan", status: "active", path: "/private/ledger", id: "internal-id" },
  ] } }), true)).toEqual({
    kind: "sections", summary: "문서 목록 · 1개",
    sections: [{ title: "호출 통합 계획", message: "계획 · 진행 중", content: undefined }],
  });
});
