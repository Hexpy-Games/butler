import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { test, expect } from "bun:test";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

const fakeProvider: ModelProviderAdapter = {
  id: "native-file-tools-closeout",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: false,
    supportsPromptCaching: false,
  },
  async invoke() {
    return { text: "unused" };
  },
};

test("NativeToolLoopRuntime executes read_file, write_file, and grep_files through the default native executor", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-native-file-tools-closeout-"));
  const previousButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
  try {
    writeFileSync(join(tempDir, "source.txt"), "alpha\nneedle-marker\nomega\n", "utf8");

    const observedCalls: string[] = [];
    const toolOutputs: Record<string, unknown> = {};
    const runtime = new NativeToolLoopRuntime({
      butlerHome: process.cwd(),
      butlerData: tempDir,
      disableAutomaticRecall: true,
      runFunctionToolPromptText: async (input) => {
        const toolNames = input.tools.map((tool) => tool.name);
        expect(toolNames).toContain("read_file");
        expect(toolNames).toContain("write_file");
        expect(toolNames).toContain("grep_files");

        const calls = [
          { name: "read_file", args: { path: "source.txt" } },
          { name: "write_file", args: { path: "created.txt", content: "created by native file tool\nneedle-marker\n", create_parent_dirs: false } },
          { name: "grep_files", args: { pattern: "needle-marker", paths: ["."], max_matches: 10 } },
        ];

        for (const call of calls) {
          await input.onAssistantTextBeforeTools?.({
            text: [
              `title: Run ${call.name}`,
              `summary: Execute ${call.name} as part of the native file tool smoke test.`,
              "rationale: The test must exercise the real native file executor through the model-selected tool path.",
              "next_step: Capture the structured result and continue to the next file operation.",
            ].join("\n"),
            toolCalls: [call],
          });
          observedCalls.push(call.name);
          toolOutputs[call.name] = await input.executeTool({
            name: call.name,
            args: call.args,
            rawArguments: JSON.stringify(call.args),
          });
        }

        return "Native file tools closeout smoke complete.";
      },
    });

    const handle = await runtime.createSession({
      sessionId: "butler/native-file-tools-closeout",
      role: "butler",
      workspacePath: tempDir,
      systemPrompt: "You are Butler.",
      metadata: { projectId: "butler", projectPath: tempDir },
    });

    const result = await runtime.runTurn({
      handle,
      provider: fakeProvider,
      model: "test/native-file-tools-closeout",
      input: { text: "Read source.txt, write created.txt, then grep for needle-marker using native file tools." },
      metadata: {
        runtimePolicy: {
          completionReview: "disabled",
          requiredNativeToolProfiles: ["workspace"],
        },
      },
    });

    expect(result.text).toContain("Native file tools closeout smoke complete");
    expect(observedCalls).toEqual(["read_file", "write_file", "grep_files"]);
    expect(existsSync(join(tempDir, "created.txt"))).toBe(true);
    expect(readFileSync(join(tempDir, "created.txt"), "utf8")).toContain("created by native file tool");

    expect((toolOutputs.read_file as { ok?: boolean }).ok).toBe(true);
    expect((toolOutputs.write_file as { ok?: boolean }).ok).toBe(true);
    const grepOutput = toolOutputs.grep_files as { ok?: boolean; matches?: unknown[] };
    expect(grepOutput.ok).toBe(true);
    expect(Array.isArray(grepOutput.matches)).toBe(true);
    expect(grepOutput.matches?.length).toBeGreaterThanOrEqual(2);
  } finally {
    if (previousButlerData === undefined) delete process.env.BUTLER_DATA;
    else process.env.BUTLER_DATA = previousButlerData;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
