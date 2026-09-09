import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBtccAgentLoop } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import type { ModelRoundRequest, ModelRoundTool } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { budgetToolOutput, readToolOutputArtifactSlice } from
  "../../packages/butler-agent/src/agent/context/tool-output-budgeter.ts";
import { readToolOutputArtifactToolDefinition } from
  "../../packages/butler-agent/src/agent/tools/monitoring/read_tool_output_artifact/definition.ts";

function tool(name: string): ModelRoundTool {
  return { name, description: name, parameters: { type: "object", properties: {} } };
}

function call(id: string, name: string, args: Record<string, unknown> = {}) {
  return { id, name, arguments: args, rawArguments: JSON.stringify(args) };
}

function resultMessage(request: ModelRoundRequest, callId: string) {
  const message = request.messages.find((entry) => entry.toolCallId === callId);
  expect(message).toBeDefined();
  return JSON.parse(message!.content);
}

const failures = [
  {
    name: "run_command",
    output: { ok: false, stdout: "Cannot find package 'tsx'", stderr: "", exit_code: 1, timed_out: false },
  },
  {
    name: "read_file",
    output: {
      ok: false, error: "all_files_failed", message: "All requested files failed.",
      files: [{ path: "src/app.ts", error: "invalid_cursor", recovery_hint: "Restart the read without a cursor." }],
    },
  },
  {
    name: "write_file",
    output: { ok: false, error: "file_exists", recovery_hint: "Read the existing file before overwriting." },
  },
  {
    name: "record_work_review",
    output: {
      ok: false,
      error: { code: "work_guard", message: "Plan needs correction.", current_stage: "plan", next_action: "replace_work_plan" },
      work: { objective: "Fix the request", plan: { actions: [] } },
    },
  },
  {
    name: "tool_describe",
    output: { ok: false, descriptions: [{ id: "native:read_file", description: "Read a file." }], missing: ["native:unknown"] },
  },
];

for (const { name, output } of failures) {
  test(`BTCC preserves ${name} failure observations in the next model round`, async () => {
    let round = 0;
    const result = await runBtccAgentLoop({
      prompt: "Use the tool result to decide what to do next.",
      tools: [tool(name)],
      executeTool: async () => output,
      modelRound: {
        async runRound(request) {
          if (round++ === 0) return { toolCalls: [call("failed", name)] };
          expect(resultMessage(request, "failed")).toMatchObject({ ok: false, output });
          return { text: "The failure details are available.", toolCalls: [] };
        },
      },
    });
    expect(result.finalText).toBe("The failure details are available.");
    expect(round).toBe(2);
  });
}

test("BTCC preserves web failure status and recovery information through its existing preview", async () => {
  let round = 0;
  await runBtccAgentLoop({
    prompt: "Read the page.",
    tools: [tool("web_read")],
    executeTool: async () => ({
      ok: false, status: 404, requested_url: "https://example.com/missing",
      error: { code: "http_error", message: "HTTP 404" },
      warnings: ["The page was not found."], public_web_evidence_items: [],
    }),
    modelRound: {
      async runRound(request) {
        if (round++ === 0) return { toolCalls: [call("web", "web_read")] };
        expect(resultMessage(request, "web")).toMatchObject({
          ok: false,
          output: { ok: false, status: 404, warnings: ["The page was not found."] },
        });
        return { text: "Page not found.", toolCalls: [] };
      },
    },
  });
});

test("BTCC failure delivery retains App-only changed-file and media filtering", async () => {
  let round = 0;
  await runBtccAgentLoop({
    prompt: "Inspect the result.", tools: [tool("write_file")],
    executeTool: async () => ({
      ok: false, error: "partial_failure", recovery_hint: "Read the current file.",
      changed_file: { lines: ["APP_ONLY_DIFF"] },
      results: [{ changedFiles: ["APP_ONLY_DIFF"] }],
      model_image_attachments: [{ path: "APP_ONLY_IMAGE" }],
    }),
    modelRound: {
      async runRound(request) {
        if (round++ === 0) return { toolCalls: [call("filtered", "write_file")] };
        const payload = resultMessage(request, "filtered");
        expect(payload.output).toEqual({
          ok: false, error: "partial_failure", recovery_hint: "Read the current file.", results: [{}],
        });
        expect(JSON.stringify(request.messages)).not.toContain("APP_ONLY_");
        return { text: "Observed.", toolCalls: [] };
      },
    },
  });
});

test("BTCC reads omitted failed command output without rerunning the command", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-failed-command-output-"));
  try {
    const stderr = Array.from({ length: 200 }, (_, index) =>
      index === 100 ? "Missing dependency: tsx. Install the declared dependencies." : `diagnostic ${index}: ${"x".repeat(80)}`,
    ).join("\n");
    let round = 0;
    let commandCalls = 0;
    const result = await runBtccAgentLoop({
      prompt: "Check the command failure details.",
      tools: [tool("run_command"), readToolOutputArtifactToolDefinition],
      executeTool: async (invocation) => {
        if (invocation.name === "run_command") {
          commandCalls++;
          return { ok: false, ...budgetToolOutput({
            butlerData: root, maxModelTokens: 200,
            result: { stdout: "", stderr, exit_code: 1, timed_out: false },
          }) };
        }
        return readToolOutputArtifactSlice({
          butlerData: root, artifactId: String(invocation.arguments.artifact_id),
          stream: "stderr", offsetLines: 100, limitLines: 1,
        });
      },
      modelRound: {
        async runRound(request) {
          if (round++ === 0) return { toolCalls: [call("command", "run_command")] };
          if (round === 2) {
            const payload = resultMessage(request, "command");
            expect(payload.ok).toBe(false);
            expect(payload.output.exit_code).toBe(1);
            expect(payload.output.stdout).toContain("Artifact ID:");
            expect(payload.output.stderr).not.toContain("Missing dependency: tsx");
            return { toolCalls: [call("slice", "read_tool_output_artifact", {
              artifact_id: payload.output.butler_tool_artifact.id,
              stream: "stderr", offset_lines: 100, limit_lines: 1,
            })] };
          }
          expect(resultMessage(request, "slice").output.stderr.text)
            .toBe("Missing dependency: tsx. Install the declared dependencies.");
          return { text: "The missing dependency is tsx.", toolCalls: [] };
        },
      },
    });
    expect(result.finalText).toBe("The missing dependency is tsx.");
    expect(commandCalls).toBe(1);
    expect(round).toBe(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
