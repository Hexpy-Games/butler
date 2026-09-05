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
import { runBtccAgentLoop } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/agent-loop.ts";
import { openAIBoundedConversationItems } from
  "../../packages/butler-agent/src/integrations/providers/openai/conversation-items.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function commandResult(stdout: string, stderr = "", command?: string) {
  const butlerData = mkdtempSync(join(tmpdir(), "btcc-output-delivery-"));
  roots.push(butlerData);
  return budgetToolOutput({
    result: { stdout, stderr, exit_code: stderr ? 1 : 0, timed_out: false },
    butlerData, command, retainOriginal: true, outputMode: "full", maxModelTokens: 8_000,
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

test("artifact metadata cannot consume the entire readable page", () => {
  const stdout = "The requested source is here.\n".repeat(30);
  const result = commandResult(stdout, "", "nl -ba src/runner/model-tool-loop.ts | sed -n '80,260p' > /tmp/loop.txt; wc -c /tmp/loop.txt; cat /tmp/loop.txt");
  const read = readToolOutputArtifactSlice({ butlerData: roots.at(-1),
    path: result.butler_tool_artifact!.path, stream: "stdout", offsetChars: 0,
    limitLines: 100, maxTokens: 1_000 });
  const { payload } = deliver("read_tool_output_artifact", read, 512);
  expect(payload.output.stdout.text.length).toBeGreaterThan(0);
  expect(payload.output.stdout.next_offset_chars === null ||
    payload.output.stdout.next_offset_chars > 0).toBe(true);
});

test("the common loop keeps fresh command and original-reader bodies after history fills", async () => {
  const stdout = "  source line with useful implementation details\n".repeat(60);
  const saved = commandResult(stdout);
  const read = readToolOutputArtifactSlice({ butlerData: roots.at(-1),
    path: saved.butler_tool_artifact!.path, stream: "stdout", offsetChars: 0,
    limitLines: 100, maxTokens: 2_000 });
  const largeStdout = "prior source listing\n".repeat(430);
  const large = commandResult(largeStdout);
  let rounds = 0;
  const result = await runBtccAgentLoop({
    prompt: "Read each result and then report.", instructions: "Keep the assigned objective.\n".repeat(100),
    maxModelFacingBytes: 16_000,
    tools: ["run_command", "read_tool_output_artifact"].map((name) => ({
      name, description: name, parameters: { type: "object", properties: {} },
    })),
    modelRound: { runRound: async (request) => {
      if (rounds > 0) {
        const latest = request.messages.findLast((message) => message.role === "tool")!;
        const payload = JSON.parse(latest.content);
        expect(latest.name === "run_command" ? payload.output.stdout : payload.output.stdout.text)
          .toBe(rounds === 1 ? largeStdout : stdout);
        const providerItems = openAIBoundedConversationItems(request.messages).items;
        const delivered = providerItems.findLast((item) => item.type === "function_call_output");
        expect(JSON.parse(String(delivered!.output))).toEqual(payload);
        expect(request.boundedContinuation!.modelFacingBytes).toBeLessThanOrEqual(16_000);
      }
      if (rounds === 12) return { text: "Read and reported.", toolCalls: [] };
      const name = rounds++ === 11 ? "read_tool_output_artifact" : "run_command";
      return { toolCalls: [{ id: `read-${rounds}`, name, arguments: {}, rawArguments: "{}" }] };
    } },
    executeTool: async (call) => {
      if (call.name === "read_tool_output_artifact") return read;
      return rounds === 1 ? large : saved;
    },
  });
  expect(result.finalText).toBe("Read and reported.");
  expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeGreaterThan(16_000);
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
