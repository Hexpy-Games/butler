import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { readTranscript } from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

let tempDir = "";
let originalButlerData: string | undefined;

const repoRoot = process.cwd();
const projectLedgerCli = join(repoRoot, "packages", "project-ledger", "bin", "project-ledger");

const fakeProvider: ModelProviderAdapter = {
  id: "fake-openai",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: true,
  },
  async invoke() {
    return { text: "unused" };
  },
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-pl-observation-"));
  originalButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  rmSync(tempDir, { recursive: true, force: true });
});

async function authorPublicDecisionForTool(
  input: {
    onAssistantTextBeforeTools?: (message: {
      text: string;
      toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
    }) => Promise<void> | void;
  },
  call: { name: string; args: Record<string, unknown> },
  text: { title?: string; summary: string; rationale: string; nextStep: string },
): Promise<void> {
  await input.onAssistantTextBeforeTools?.({
    text: [
      `title: ${text.title ?? "Project Ledger failure check"}`,
      `summary: ${text.summary}`,
      `rationale: ${text.rationale}`,
      `next_step: ${text.nextStep}`,
    ].join("\n"),
    toolCalls: [call],
  });
}

function runLedger(projectPath: string, args: string[]): void {
  const result = spawnSync(process.execPath, [projectLedgerCli, ...args, "--project", projectPath, "--json"], {
    encoding: "utf8",
    env: { ...process.env, BUTLER_DATA: tempDir },
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
}

test("native runtime exposes structured Project Ledger failures in model-visible observations", async () => {
  const projectPath = join(tempDir, "project-ledger", "projects", "butler");
  runLedger(projectPath, ["init", "--id", "butler", "--name", "Butler"]);
  runLedger(projectPath, [
    "work",
    "create",
    "--id",
    "W-INVALID-TRANSITION",
    "--title",
    "Invalid transition work",
    "--status",
    "in_progress",
    "--spec-exemption",
    "--acceptance-exemption",
    "--validation",
    "validation evidence",
    "--review",
    "review evidence",
    "--report",
    "reports/invalid-transition.md",
  ]);
  runLedger(projectPath, [
    "work",
    "create",
    "--id",
    "W-COMPLETION-GATE",
    "--title",
    "Completion gate work",
    "--status",
    "review",
  ]);
  runLedger(projectPath, ["index"]);

  let invalidTransition: Record<string, unknown> | null = null;
  let completionGate: Record<string, unknown> | null = null;
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    butlerHome: repoRoot,
    butlerData: tempDir,
    runFunctionToolPromptText: async (input) => {
      await authorPublicDecisionForTool(
        input,
        {
          name: "project_ledger_work_complete",
          args: { project_path: projectPath, id: "W-INVALID-TRANSITION" },
        },
        {
          summary: "Project Ledger work completion 전이 실패 observation을 확인합니다.",
          rationale: "CLI가 알려주는 다음 상태 전이 힌트가 모델에게 보여야 합니다.",
          nextStep: "work_complete을 호출하고 구조화된 실패 내용을 검사합니다.",
        },
      );
      invalidTransition = await input.executeTool({
        name: "project_ledger_work_complete",
        args: { project_path: projectPath, id: "W-INVALID-TRANSITION" },
        rawArguments: JSON.stringify({ project_path: projectPath, id: "W-INVALID-TRANSITION" }),
      }) as Record<string, unknown>;
      await authorPublicDecisionForTool(
        input,
        {
          name: "project_ledger_work_complete",
          args: { project_path: projectPath, id: "W-COMPLETION-GATE" },
        },
        {
          summary: "Project Ledger completion gate 실패 observation을 확인합니다.",
          rationale: "누락된 completion evidence와 retry hint가 모델에게 보여야 합니다.",
          nextStep: "gate failure를 호출하고 구조화된 실패 내용을 검사합니다.",
        },
      );
      completionGate = await input.executeTool({
        name: "project_ledger_work_complete",
        args: { project_path: projectPath, id: "W-COMPLETION-GATE" },
        rawArguments: JSON.stringify({ project_path: projectPath, id: "W-COMPLETION-GATE" }),
      }) as Record<string, unknown>;
      return "Project Ledger 실패 observation을 확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/project-ledger-error-observation",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
    metadata: { projectId: "butler" },
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "Project Ledger work completion 실패 observation을 확인해줘." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  const invalidResult = invalidTransition as unknown as Record<string, unknown>;
  const completionGateResult = completionGate as unknown as Record<string, unknown>;
  expect(invalidResult).toMatchObject({ ok: false, observation_kind: "validation_failed" });
  expect(completionGateResult).toMatchObject({ ok: false, observation_kind: "validation_failed" });
  const invalidContent = String(invalidResult.model_visible_content ?? "");
  expect(invalidContent).toContain("project_ledger_closeout_failed");
  expect(invalidContent).toContain("check_failed");
  expect(invalidContent).toContain("project_ledger_check");
  const gateContent = String(completionGateResult.model_visible_content ?? "");
  expect(gateContent).toContain("completion_gate_failed");
  expect(gateContent).toContain("missing_validation");
  expect(gateContent).toContain("missing_report");
  expect(gateContent).toContain("native_next: project_ledger_work_complete id: W-COMPLETION-GATE");
  expect(gateContent).toContain("project_ledger_work_complete");
  for (const privateText of [projectPath, tempDir]) {
    expect(invalidContent).not.toContain(privateText);
    expect(gateContent).not.toContain(privateText);
  }
  const transcript = readTranscript("butler/main/project-ledger-error-observation");
  const toolResults = transcript.filter((event) =>
    event.kind === "tool_result" &&
    event.payload.name === "project_ledger_work_complete",
  );
  expect(toolResults).toHaveLength(2);
  const firstObservation = toolResults[0]?.payload.observation as { modelVisibleContent?: unknown } | undefined;
  const secondObservation = toolResults[1]?.payload.observation as { modelVisibleContent?: unknown } | undefined;
  expect(String(firstObservation?.modelVisibleContent ?? "")).toContain("project_ledger_closeout_failed");
  expect(String(secondObservation?.modelVisibleContent ?? "")).toContain("completion_gate_failed");
});
