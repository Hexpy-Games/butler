import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetToolOutput, readToolOutputArtifactSlice } from
  "../../packages/butler-agent/src/agent/context/tool-output-budgeter.ts";
import { retainToolEvidence, readToolEvidenceArtifactSlice } from
  "../../packages/butler-agent/src/agent/context/tool-evidence-retention.ts";
import { toolResultToMessage } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/tool-result-message.ts";
import { beginToolResultModelPreviewBatch, createToolResultModelPreviewContext } from
  "../../packages/butler-agent/src/agent/tools/tool-result-serialization.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function commandResult(stdout: string, stderr = "") {
  const butlerData = mkdtempSync(join(tmpdir(), "btcc-output-delivery-"));
  roots.push(butlerData);
  return budgetToolOutput({
    result: { stdout, stderr, exit_code: stderr ? 1 : 0, timed_out: false },
    butlerData, retainOriginal: true, outputMode: "full", maxModelTokens: 8_000,
  });
}

function deliver(name: string, output: unknown, maxBytes = 50 * 1024) {
  const context = createToolResultModelPreviewContext();
  beginToolResultModelPreviewBatch(context, { resultCount: 1, maxBytes });
  const message = toolResultToMessage({
    result: { toolCallId: "command-call", name, ok: true, output },
    modelPreviewContext: context,
  });
  return { content: message.content, payload: JSON.parse(message.content) };
}

test("model receives the full budgeted command body including its middle and whitespace", () => {
  const stdout = `  ${"import setup\n".repeat(360)}\nrunSandyDecisionJudgeOutcome(input);\n${"rest of module\n".repeat(360)}  `;
  const result = commandResult(stdout);
  expect(result.output_presentation?.truncated).toBe(false);
  const { payload } = deliver("run_command", result);
  expect(payload.output.stdout).toBe(stdout);
  expect(payload.output.output_presentation.truncated).toBe(false);
});

test("a smaller model budget keeps command failure facts and an exact original reader", () => {
  const stdout = "output\n".repeat(900);
  const stderr = `  ${"trace\n".repeat(300)}actual failing diagnostic\n  `;
  const result = commandResult(stdout, stderr);
  const { content, payload } = deliver("run_command", result, 1_600);
  expect(Buffer.byteLength(content)).toBeLessThanOrEqual(1_600);
  expect(payload.output).toMatchObject({ exit_code: 1, timed_out: false, output_presentation: { truncated: true } });
  expect(payload.model_preview.artifact_read.capability).toBe("read_tool_output_artifact");
  const original = readToolOutputArtifactSlice({ path: payload.model_preview.artifact_read.arguments.path,
    butlerData: roots.at(-1), stream: "stderr", limitLines: 500, maxTokens: 8_000 });
  expect(original.stderr?.text).toBe(stderr);
  expect(original.stderr?.next_offset_chars).toBeNull();
});

test("artifact pages reduced for the model never skip hidden text or create nested artifacts", () => {
  const stdout = `  begin\r\n${"abcdefghijklmnopqrstuvwxyz\r\n".repeat(300)}end  `;
  const result = commandResult(stdout);
  let offset = 0;
  let restored = "";
  while (true) {
    const read = readToolOutputArtifactSlice({ butlerData: roots.at(-1),
      path: result.butler_tool_artifact!.path, stream: "stdout", offsetChars: offset,
      limitLines: 500, maxTokens: 8_000 });
    const { content, payload } = deliver("read_tool_output_artifact", read, 1_800);
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(1_800);
    const slice = payload.output.stdout;
    expect(slice.text.length).toBeGreaterThan(0);
    restored += slice.text;
    expect(payload.output.artifact.path).toBe(result.butler_tool_artifact!.path);
    if (slice.next_offset_chars === null) break;
    expect(slice.next_offset_chars).toBe(offset + slice.text.length);
    offset = slice.next_offset_chars;
  }
  expect(restored).toBe(stdout);
});

test("evidence reader resumes a reduced page from the actual nonzero character offset", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "btcc-evidence-delivery-"));
  roots.push(butlerData);
  const text = `first\n  ${"long evidence line ".repeat(600)}\r\nlast  `;
  const retained = retainToolEvidence({ context: { butlerData }, toolName: "read_file",
    output: text, reason: "model preview" });
  let restored = "";
  let offset = text.indexOf("\n") + 1;
  const expected = text.slice(offset);
  while (true) {
    const read = readToolEvidenceArtifactSlice({ butlerData, path: retained.artifact!.path,
      offsetChars: offset, limitLines: 500, maxTokens: 8_000 });
    const { payload } = deliver("read_tool_evidence_artifact", read, 1_800);
    const slice = payload.output.text;
    expect(slice.text.length).toBeGreaterThan(0);
    expect(slice.start_char).toBe(offset);
    restored += slice.text;
    if (slice.next_offset_chars === null) break;
    expect(slice.next_offset_chars).toBe(offset + slice.text.length);
    offset = slice.next_offset_chars;
  }
  expect(restored).toBe(expected);
});
