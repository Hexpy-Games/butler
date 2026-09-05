import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUTLER_TOOLS } from "../../packages/butler-agent/src/agent/tools/registry.ts";
import { createToolResultModelPreviewContext, toolResultPayloadForProvider } from
  "../../packages/butler-agent/src/agent/tools/tool-result-serialization.ts";
import { toolResultToMessage } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/tool-result-message.ts";
import { withoutChangedFileDetails } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/tool-result-message.ts";
import { changedFileDetailsFromToolResult } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-changed-files.ts";
import { executeReadFileTool } from
  "../../packages/butler-agent/src/agent/tools/file-tools/read_file/index.ts";
import { executeWriteFileTool } from
  "../../packages/butler-agent/src/agent/tools/file-tools/write_file/index.ts";
import { transformPublicDataTable } from
  "../../packages/butler-agent/src/agent/tools/data-table/transform_public_data_table/executor.ts";
import { createGuidedActivityProjection } from
  "../../packages/butler-agent/src/agent/btcc/projection/index.ts";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/open-btcc-sqlite-stores.ts";
import { createGuidedOperationResultRuntime } from
  "../../packages/butler-agent/src/agent/btcc/operation-result-replay/index.ts";

const roots: string[] = [];
function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "butler-result-integrity-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function providerOutput(name: string, output: unknown) {
  const message = toolResultToMessage({
    result: { toolCallId: "call", name, ok: true, output },
    modelPreviewContext: createToolResultModelPreviewContext(),
  });
  return JSON.parse(message.content).output;
}

test("every registered tool description keeps its complete nested invocation schema", () => {
  const damaged: string[] = [];
  for (const tool of BUTLER_TOOLS) {
    const output = { ok: true, descriptions: [{ id: `native:${tool.name}`, schema: tool.parameters }] };
    const result = providerOutput("tool_describe", output);
    if (JSON.stringify(result.descriptions[0].schema) !== JSON.stringify(tool.parameters)) damaged.push(tool.name);
  }
  expect(damaged).toEqual([]);
});

test("journal preparation never treats schema or MCP user data as file mutation metadata", () => {
  const output = { ok: true, changed_files: [{ path: "not-a-mutation", additions: 1, deletions: 0, lines: [] }],
    schema: { properties: { changed_files: { type: "array" }, changedFiles: { type: "string" }, stack: { type: "string" } } } };
  for (const name of ["tool_describe", "call_mcp_tool", "read_file"]) {
    expect(withoutChangedFileDetails(output, name)).toEqual(output);
    expect(changedFileDetailsFromToolResult(output, name)).toEqual([]);
    expect(providerOutput(name, output)).toMatchObject(output);
  }
  const batch = { ok: true, applied: [{ path: "file.ts", changed_file: output.changed_files[0] }],
    evidence_receipts: [{ references: { applied: [{ changed_file: output.changed_files[0] }] } }] };
  expect(withoutChangedFileDetails(batch, "edit_file")).toEqual({ ok: true,
    applied: [{ path: "file.ts" }], evidence_receipts: [{ references: { applied: [{}] } }] });
});

test("actual read -> model message -> overwrite preserves bytes and the required file hash", async () => {
  const root = temporaryRoot();
  const source = "  first();\n  second();\n";
  writeFileSync(join(root, "code.ts"), source);
  const read = await executeReadFileTool({ arguments: { requests: [{ path: "code.ts" }] } }, { workspacePath: root });
  const output = providerOutput("read_file", read);
  expect(output.files[0].content).toBe(source);
  expect(output.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  const changed = source.replace("second", "updated");
  const written = await executeWriteFileTool({ arguments: {
    path: "code.ts", content: changed, overwrite: true, expected_sha256: output.files[0].sha256,
  } }, { workspacePath: root });
  expect(written.ok).toBe(true);
  expect(readFileSync(join(root, "code.ts"), "utf8")).toBe(changed);
});

test("file and search results do not silently lose entries, cursors or pending facts", () => {
  const listing = { ok: true, files: Array.from({ length: 110 }, (_, i) => ({ path: `file-${i}.ts` })), truncated: false, next_cursor: null };
  expect(providerOutput("list_files", listing)).toMatchObject(listing);
  const grep = { ok: true, pattern: "value", matches: Array.from({ length: 30 }, (_, i) => ({
    path: `file-${i}.ts`, line: 3, text: "  value", context: [{ line: 2, text: "before" }],
  })), truncated: true, next_cursor: "next-search-page" };
  expect(providerOutput("grep_files", grep)).toMatchObject(grep);
  const pending = { ok: true, files: [{ ok: true, path: "pending.ts", pending: true, skipped: true, recovery_hint: "continue", content: "" }] };
  expect(providerOutput("read_file", pending)).toMatchObject(pending);
});

test("bridge and direct command results keep the same model-visible output", () => {
  const output = { ok: true, exit_code: 0, stdout: "output ".repeat(1000), stderr: "", model_visible_content: "detail ".repeat(1000) };
  const direct = providerOutput("run_command", output);
  const bridge = providerOutput("tool_call", { ...output, bridge_invocation: { id: "native:run_command", provider: "native" } });
  expect(bridge.stdout).toBe(direct.stdout);
  expect(bridge.model_visible_content).toBe(direct.model_visible_content);
});

test("short lines within the byte allocation stay complete without an independent line gate", () => {
  const reference = { capability: "read_operation_results" as const, arguments: {
    result_ref: "lines", sha256: "a".repeat(64), revision: null, work_id: null, offset: 0, length: 4096,
  }, total_bytes: 20_000 };
  const projected = toolResultPayloadForProvider({ ok: true, output: { content: "row\n".repeat(3000) } }, {
    toolName: "custom_tool", exactReadReference: reference,
  });
  expect(projected.model_preview).toBeUndefined();
  expect((projected.output as { content: string }).content).toBe("row\n".repeat(3000));
});

test("accepted CSV rows and columns are all present in the generated artifact", () => {
  const root = temporaryRoot();
  const columns = Array.from({ length: 15 }, (_, i) => `column${i}`);
  const rows = Array.from({ length: 60 }, (_, row) => Object.fromEntries(columns.map((column) => [column, `${column}-row${row}`])));
  const result = transformPublicDataTable({ butlerData: root, args: { columns, rows } });
  expect(result.row_count).toBe(rows.length);
  const csv = readFileSync(join(root, "artifacts/public-data", String(result.artifact_label)), "utf8");
  expect(csv.trimEnd().split("\n")).toHaveLength(61);
  expect(csv).toContain("column14-row59");
});

test("accepted continue_work becomes the owner of following tool calls and survives restore", async () => {
  const activity = createGuidedActivityProjection({ turnId: "turn", managedInitially: true, progress: { stateChanged() {} } });
  async function observe(name: string, id: string) {
    const call = { name, effectiveToolName: name, args: {}, callId: id };
    activity.observeToolBatch({ text: "", toolCalls: [call] });
    return activity.observeTool(call);
  }
  const old = await observe("read_file", "old");
  const current = await observe("continue_work", "continue");
  await activity.publishAccepted(current);
  expect(current.activityId).not.toBe(old.activityId);
  const next = await observe("grep_files", "next");
  expect(next.activityId).toBe(current.activityId);
  const restored = createGuidedActivityProjection({ turnId: "turn", managedInitially: true,
    restored: activity.snapshot(), progress: { stateChanged() {} } });
  const call = { name: "list_files", effectiveToolName: "list_files", args: {}, callId: "restored" };
  restored.observeToolBatch({ text: "", toolCalls: [call] });
  expect((await restored.observeTool(call)).activityId).toBe(current.activityId);
});

test("a tool after accepted continue_work in the same batch binds to the new activity", async () => {
  const activity = createGuidedActivityProjection({ turnId: "turn", managedInitially: true });
  const read = { name: "read_file", effectiveToolName: "read_file", args: {}, callId: "before" };
  activity.observeToolBatch({ text: "기존 확인", toolCalls: [read] });
  const before = await activity.observeTool(read);
  const resume = { name: "continue_work", effectiveToolName: "continue_work", args: {}, callId: "resume" };
  const next = { ...read, callId: "after" };
  activity.observeToolBatch({ text: "현재 진행 내용을 확인합니다.", toolCalls: [resume, next] });
  const accepted = await activity.observeTool(resume);
  await activity.publishAccepted(accepted);
  expect(accepted.activityId).not.toBe(before.activityId);
  expect((await activity.observeTool(next)).activityId).toBe(accepted.activityId);
  const review = { name: "record_work_review", effectiveToolName: "record_work_review",
    args: { subject: "plan", verdict: "accept" }, callId: "plan-review" };
  const first = { ...read, callId: "before-review" }, last = { ...read, callId: "after-review" };
  activity.observeToolBatch({ text: "계획 검토 후 실행", toolCalls: [first, review, last] });
  const beforeReview = await activity.observeTool(first);
  await activity.publishAccepted(await activity.observeTool(review));
  const afterReview = await activity.observeTool(last);
  expect(afterReview.activityId).not.toBe(beforeReview.activityId);
  expect(afterReview.displayStage).toBe("execution");
});

test.each([false, true])("accepted Plan Review publishes the next execution stage after restore (action title: %s)", async (withTitle) => {
  const published: Array<{ activityId: string; displayStage?: string }> = [];
  const progress = { stateChanged() {}, phaseActivityChanged(event: { activityId: string; displayStage?: string }) { published.push(event); } };
  const activity = createGuidedActivityProjection({ turnId: "turn", managedInitially: true, progress });
  const review = { name: "record_work_review", effectiveToolName: "record_work_review", callId: "review",
    args: { subject: "plan", verdict: "accept", ...(withTitle ? { action_updates: [{ action_key: "input.txt 수정", status: "active" }] } : {}) } };
  activity.observeToolBatch({ text: "계획을 검토했습니다.", toolCalls: [review] });
  const prior = await activity.observeTool(review);
  await activity.publishAccepted(prior);
  const restored = createGuidedActivityProjection({ turnId: "turn", restored: activity.snapshot(), progress });
  const write = { name: "write_file", effectiveToolName: "write_file", args: { path: "input.txt" }, callId: "write" };
  restored.observeToolBatch({ text: "input.txt를 수정합니다.", toolCalls: [write] });
  const execution = await restored.observeTool(write);
  expect(execution.activityId).not.toBe(prior.activityId);
  expect(execution.displayStage).toBe("execution");
  expect(published.at(-1)).toMatchObject({ activityId: execution.activityId, displayStage: "execution" });
});

test("large provider previews reconstruct the complete stored result with replay compression disabled", () => {
  const root = temporaryRoot();
  const stores = openBtccSqliteStores({ dbPath: join(root, "btcc.sqlite"), ownerId: "integrity" });
  try {
    const output = { ok: true, descriptions: [{ schema: { description: "한글🙂 ".repeat(15000) } }] };
    stores.guidedToolJournal.start({ turnId: "turn", callId: "call", toolName: "tool_describe", rawArguments: "{}", arguments: {} });
    stores.guidedToolJournal.finish({ callId: "call", status: "completed", result: output });
    const runtime = createGuidedOperationResultRuntime({ mode: "disabled", exactReadCapability: true,
      turnId: "turn", turnRevision: 1, sessionId: "session", journal: stores.guidedToolJournal,
      exactReader: stores.guidedOperationResultReader });
    const reference = runtime.replay?.previewReferenceForCall("call");
    expect(reference).toBeDefined();
    const preview = toolResultPayloadForProvider({ ok: true, output }, { toolName: "tool_describe", exactReadReference: reference! });
    expect(preview.model_preview).toMatchObject({ truncated: true, exact_read: reference });
    const bytes: Buffer[] = [];
    let offset = 0;
    while (offset < reference!.total_bytes) {
      const page = runtime.read!({ ...reference!.arguments, offset }) as { data: string; length: number; nextOffset: number | null };
      const chunk = Buffer.from(page.data, "base64");
      expect(chunk.byteLength).toBeGreaterThan(0);
      expect(page.length).toBe(chunk.byteLength);
      bytes.push(chunk);
      offset += chunk.byteLength;
      if (page.nextOffset !== null) expect(page.nextOffset).toBe(offset);
    }
    expect(JSON.parse(Buffer.concat(bytes).toString("utf8"))).toEqual(output);
    expect(stores.guidedToolJournal.findForTurn("turn", "call")?.deliveryState).toBeUndefined();
  } finally { stores.close(); }
});
