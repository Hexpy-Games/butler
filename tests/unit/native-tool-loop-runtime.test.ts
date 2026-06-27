import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  appendTranscriptEvent,
  createTranscriptEvent,
  readTranscript,
} from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";
import type { RuntimeTurnEventInput } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import {
  applyCorrectionChallengeGuard,
  applyShortCueRhythmGuard,
  applyShortUtteranceCorrectionGuard,
  applyWebSearchCitationGuard,
  enforceGroundedActionClaims,
  NativeToolLoopRuntime,
  recentConversationBudgetForTurn,
} from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";
import { TodoListStore } from "../../packages/butler-agent/src/agent/work/todo-list.ts";
import { readContextMonitor } from "../../packages/butler-agent/src/operations/metrics/context-monitor.ts";
import {
  operationalMetricsPath,
  readOperationalMetricEvents,
} from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import { addFeedbackEntry } from "../../packages/butler-agent/src/agent/cognition/feedback/buffer.ts";
import { requiredExplicitToolNames } from "../../packages/butler-agent/src/agent/policy/runtime-policy.ts";
import {
  completionObligationIncompleteReason,
  completionReviewIncompleteReason,
  containsFinalPublicWorkDecisionLeak,
  containsFinalToolImplementationLeak,
  goalCompletionReviewPrompt,
  stripLeadingPublicWorkDecisionBlock,
  stripToolImplementationLeakLines,
} from "../../packages/butler-agent/src/agent/output/completion/final-output-contract.ts";
import {
  createButlerToolExecutor,
  satisfiedCompletionObligationsForToolResult,
} from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import {
  publicWorkDecisionsFromAssistantText,
  takePublicWorkDecisionForTool,
} from "../../packages/butler-agent/src/agent/output/public-work/decisions.ts";
import { createEvidenceCapabilityReceipt } from "../../packages/butler-agent/src/agent/output/evidence/ledger.ts";
import {
  evidenceTranscriptToolCallArgumentsProjection,
  evidenceTranscriptToolResultProjection,
} from "../../packages/butler-agent/src/agent/output/evidence/transcript-result.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

let tempDir = "";
let originalButlerData: string | undefined;

function capabilityReceipt(input: {
  id: string;
  producerName: string;
  capability: "source_verified" | "command_executed" | "durable_artifact" | "data_table_created" | "chart_rendered";
  evidenceKind: "source_page" | "project_state" | "execution_result" | "artifact" | "data_table" | "chart";
  satisfies: Array<"source_verified" | "command_executed" | "durable_artifact" | "data_table_created" | "chart_rendered">;
  reference?: Record<string, string>;
}) {
  return {
    receipt_id: input.id,
    schema_version: "evidence-capability.v1",
    producer: { kind: "tool", name: input.producerName },
    capability: input.capability,
    evidence_kind: input.evidenceKind,
    maturity: "verified",
    confidence: 0.9,
    verified: true,
    summary: "Structured capability evidence was verified.",
    references: input.reference ? [input.reference] : [],
    satisfies: input.satisfies,
    limitations: [],
    created_at: "2026-06-22T08:09:00.000Z",
  };
}

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
  tempDir = mkdtempSync(join(tmpdir(), "butler-native-runtime-"));
  originalButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  rmSync(tempDir, { recursive: true, force: true });
});

test("native runtime injects Project Ledger Runtime Context only for project-origin sessions", async () => {
  const prompts: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runFunctionToolPromptText: async (input) => {
      prompts.push(input.prompt);
      return `response ${prompts.length}`;
    },
  });

  const projectHandle = await runtime.createSession({
    sessionId: "butler/project-origin",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
    metadata: { projectId: "butler" },
  });
  await runtime.runTurn({
    handle: projectHandle,
    provider: fakeProvider,
    model: "openai/gpt-5.5",
    input: { text: "Project Ledger 기준으로 상태를 확인해줘." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  const nonProjectHandle = await runtime.createSession({
    sessionId: "butler/non-project",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });
  await runtime.runTurn({
    handle: nonProjectHandle,
    provider: fakeProvider,
    model: "openai/gpt-5.5",
    input: { text: "상태를 확인해줘." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(prompts).toHaveLength(2);
  const projectPrompt = prompts[0] ?? "";
  const nonProjectPrompt = prompts[1] ?? "";

  expect(projectPrompt).toContain("## Project Ledger Runtime Context");
  expect(projectPrompt).toContain("RuntimeSessionInit.metadata.projectId=butler");
  expect(projectPrompt).toContain("Treat project-ledger as the default starting context");
  expect(projectPrompt).toContain("Before broad project/codebase investigation");
  expect(projectPrompt).toContain("inspect_project_status");
  expect(projectPrompt).toContain("query_project_work");

  expect(nonProjectPrompt).not.toContain("## Project Ledger Runtime Context");
  expect(nonProjectPrompt).not.toContain("Treat project-ledger as the default starting context");
  expect(nonProjectPrompt).not.toContain("Before broad project/codebase investigation");
  expect(nonProjectPrompt).not.toContain("inspect_project_status");
  expect(nonProjectPrompt).not.toContain("query_project_work");
});

test("native runtime gives worker sessions the execution tool loop and role-limited tool profile", async () => {
  const toolCatalogs: string[][] = [];
  const runtime = new NativeToolLoopRuntime({
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runFunctionToolPromptText: async (input) => {
      toolCatalogs.push(input.tools.map((tool) => tool.name));
      return "Worker evidence recorded.";
    },
    runPromptText: async () => {
      throw new Error("worker sessions must not fall back to text-only prompt execution");
    },
  });
  const handle = await runtime.createSession({
    sessionId: "worker/native-tool-profile",
    role: "worker",
    workspacePath: tempDir,
    systemPrompt: "You are a Butler worker.",
    metadata: { projectPath: tempDir },
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/gpt-5.5",
    input: { text: "Implement the assigned fixture change and verify it." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(result.text).toBe("Worker evidence recorded.");
  expect(toolCatalogs).toHaveLength(1);
  const names = toolCatalogs[0]!;
  expect(names).toContain("run_command");
  expect(names).toContain("update_todo_list");
  expect(names).toContain("update_work_stream_state");
  expect(names).not.toContain("dispatch_worker");
  expect(names).not.toContain("create_planned_task");
  expect(names).not.toContain("run_planned_task");
  expect(names).not.toContain("repair_planned_task");
  expect(names).not.toContain("create_work_orchestration");
  expect(names).not.toContain("run_ready_work_streams");
  expect(names).not.toContain("write_planned_public_report");
});

test("native runtime injects recent transcript context and excludes current inbound event", async () => {
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: "butler/main",
    kind: "inbound",
    payload: {
      eventId: "telegram:1:main:10",
      message: { text: "내 이름은 테스트 사용자입니다" },
    },
  }));
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: "butler/main",
    kind: "outbound",
    payload: {
      message: { text: "네, 테스트 사용자님으로 기억하겠습니다." },
    },
  }));
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: "butler/main",
    kind: "inbound",
    payload: {
      eventId: "telegram:1:main:11",
      message: { text: "방금 말한 내 이름이 뭐야?" },
    },
  }));

  let capturedPrompt = "";
  const runtime = new NativeToolLoopRuntime({
    runFunctionToolPromptText: async (input) => {
      capturedPrompt = input.prompt;
      return "테스트 사용자님입니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "telegram:1:main:11",
      accountId: "default",
      transport: "telegram",
      peer: { kind: "dm", id: "1" },
      sender: { id: "1" },
      message: {
        id: "11",
        text: "방금 말한 내 이름이 뭐야?",
        timestamp: new Date().toISOString(),
      },
    },
  });

  expect(result.text).toBe("테스트 사용자님입니다.");
  expect(capturedPrompt).toContain("## Recent Conversation");
  expect(capturedPrompt).toContain("user: 내 이름은 테스트 사용자입니다");
  expect(capturedPrompt).toContain("butler: 네, 테스트 사용자님으로 기억하겠습니다.");
  expect(capturedPrompt.match(/방금 말한 내 이름이 뭐야/g)?.length).toBe(1);
});

test("native runtime recent conversation budget shrinks when compact summary exists", () => {
  expect(recentConversationBudgetForTurn({
    configuredBudget: 16_000,
    compactionContext: "## Compaction Summary\nHistoric context was compacted.",
  })).toBe(2_000);
  expect(recentConversationBudgetForTurn({
    configuredBudget: 1_200,
    compactionContext: "## Compaction Summary\nHistoric context was compacted.",
  })).toBe(1_200);
  expect(recentConversationBudgetForTurn({
    configuredBudget: 16_000,
    compactionContext: "",
  })).toBe(16_000);
});

test("native runtime keeps prior attachment content out of recent conversation while preserving attachment references", async () => {
  const fileId = "file-00000000-0000-4000-8000-000000000003";
  mkdirSync(join(tempDir, "app-server", "message-files"), { recursive: true });
  writeFileSync(
    join(tempDir, "app-server", "message-files", fileId),
    "# Latest Draft\n\nUnique latest attached draft body.",
  );
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: "butler/main",
    kind: "inbound",
    payload: {
      eventId: "app:previous",
      message: {
        text: "다시 보내줄게.",
        attachments: [{
          id: fileId,
          kind: "document",
          mimeType: "text/markdown",
          fileName: "index.md",
          sizeBytes: 45,
        }],
      },
    },
  }));

  let capturedPrompt = "";
  const runtime = new NativeToolLoopRuntime({
    runFunctionToolPromptText: async (input) => {
      capturedPrompt = input.prompt;
      return "확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/gpt-5.5",
    input: {
      eventId: "app:current",
      accountId: "default",
      transport: "app",
      peer: { kind: "dm", id: "chat" },
      sender: { id: "app-user" },
      message: {
        id: "current",
        text: "문서 전체 첨삭 포인트만 정리해.",
        timestamp: new Date().toISOString(),
      },
    },
  });

  expect(capturedPrompt).toContain("## Recent Conversation");
  expect(capturedPrompt).toContain("index.md");
  expect(capturedPrompt).not.toContain("Unique latest attached draft body.");
});

test("native runtime injects active feedback buffer before model execution", async () => {
  addFeedbackEntry(tempDir, {
    text: "이제 답변은 항상 먼저 사용자의 최신 피드백을 확인한 뒤 작성하세요.",
    targetRef: "persona:runtime",
    category: "style",
    scope: "global",
    promotionTarget: "persona",
    priority: "critical",
  });

  let capturedPrompt = "";
  const runtime = new NativeToolLoopRuntime({
    runFunctionToolPromptText: async (input) => {
      capturedPrompt = input.prompt;
      return "반영했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "telegram:1:main:12",
      accountId: "default",
      transport: "telegram",
      peer: { kind: "dm", id: "1" },
      sender: { id: "1" },
      message: {
        id: "12",
        text: "응답해줘",
        timestamp: new Date().toISOString(),
      },
    },
  });

  expect(result.text).toBe("반영했습니다.");
  expect(capturedPrompt).toContain("## Active Feedback Buffer");
  expect(capturedPrompt).toContain("이제 답변은 항상 먼저 사용자의 최신 피드백을 확인한 뒤 작성하세요.");
});

test("native runtime does not duplicate feedback buffer when prompt context already carries it", async () => {
  addFeedbackEntry(tempDir, {
    text: "이 문구는 중복 삽입되면 안 됩니다.",
    targetRef: "persona:runtime",
    category: "style",
    scope: "global",
    promotionTarget: "persona",
    priority: "critical",
  });

  let capturedPrompt = "";
  const runtime = new NativeToolLoopRuntime({
    runFunctionToolPromptText: async (input) => {
      capturedPrompt = input.prompt;
      return "중복 없이 반영했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "telegram:1:main:13",
      accountId: "default",
      transport: "telegram",
      peer: { kind: "dm", id: "1" },
      sender: { id: "1" },
      message: {
        id: "13",
        text: "응답해줘",
        timestamp: new Date().toISOString(),
      },
    },
    metadata: {
      promptContext: "## Active Feedback Buffer\n\n- prompt-context feedback",
    },
  });

  expect(result.text).toBe("중복 없이 반영했습니다.");
  expect(capturedPrompt.match(/## Active Feedback Buffer/g)?.length).toBe(1);
  expect(capturedPrompt).toContain("prompt-context feedback");
  expect(capturedPrompt).not.toContain("이 문구는 중복 삽입되면 안 됩니다.");
});

test("native runtime emits safe public turn events for tool, guard, and final phases", async () => {
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "en",
    executeButlerTool: async () => ({ ok: true, outputText: "safe result" }),
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "web_search",
        args: { query: "safe docs" },
        rawArguments: "{\"query\":\"safe docs\"}",
      });
      return "확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "문서를 확인해줘" },
    emitTurnEvent: (event) => {
      events.push({ kind: event.kind, payload: event.payload });
    },
  });

  expect(result.text).toBe("확인했습니다.");
  expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining([
    "turn.iteration.started",
    "work.block.started",
    "tool.started",
    "tool.completed",
    "work.block.completed",
    "guard.started",
    "guard.completed",
    "message.final.started",
    "message.final.completed",
    "turn.completed",
  ]));
  const serializedEvents = JSON.stringify(events);
  expect(serializedEvents).not.toContain("raw transcript");
  expect(serializedEvents).not.toContain("<think>");
  expect(events.find((event) => event.kind === "work.block.started")?.payload?.label)
    .toBe("Searching public web sources for safe docs.");
  expect(events.find((event) => event.kind === "tool.started")?.payload?.safeLabel)
    .toBe("Web search: safe docs");
});

test("native runtime emits dynamic preparation progress before the first model response", async () => {
  const progressActions: Array<Record<string, any>> = [];
  const turnEvents: Array<Record<string, any>> = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    runFunctionToolPromptText: async () => {
      const preparationProgress = progressActions.find((action) =>
        action.kind === "tool_progress" && action.activityKind === "model",
      );
      expect(preparationProgress).toBeTruthy();
      return "확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/dynamic-preparation-progress",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/gpt-5.5",
    input: {
      eventId: "app:dynamic-preparation-progress",
      accountId: "local",
      transport: "app",
      peer: { kind: "dm", id: "general" },
      sender: { id: "app-user" },
      message: {
        id: "dynamic-preparation-progress",
        text: "내 비밀 경로 /Users/example/private 를 그대로 노출하지 말고 상태를 보여줘",
        timestamp: new Date().toISOString(),
      },
    },
    metadata: {
      promptContext: "## Project Context\n\n- Runtime visibility spec fixture.",
      runtimePolicy: { completionReview: "disabled" },
    },
    emitTurnEvent: (event) => {
      turnEvents.push(event as Record<string, any>);
    },
    emitIntermediateDelivery: async (action) => {
      if (action.metadata?.kind === "tool_progress") {
        progressActions.push(action.metadata as Record<string, any>);
      }
    },
  });

  expect(result.text).toBe("확인했습니다.");
  const preparationProgress = progressActions.find((action) =>
    action.kind === "tool_progress" && action.activityKind === "model",
  );
  expect(preparationProgress?.safeLabel).toBe("응답 준비 중");
  expect(preparationProgress?.inputLabel).toBe("");
  expect(preparationProgress?.detailRows).toEqual([]);
  expect(preparationProgress?.safeLabel).not.toBe("Working");
  expect(preparationProgress?.safeLabel).not.toBe("Thinking");
  const serialized = JSON.stringify(progressActions);
  expect(serialized).not.toContain("gpt-5.5");
  expect(serialized).not.toContain("도구 루프");
  expect(serialized).not.toContain("tool loop");
  expect(serialized).not.toContain("/Users/example/private");
  expect(serialized).not.toContain("Runtime visibility spec fixture");
  expect(serialized).not.toContain("그대로 노출");
  expect(turnEvents.find((event) =>
    event.kind === "tool.progress" && event.payload?.activityKind === "model",
  )?.payload?.safeLabel).toBe(preparationProgress?.safeLabel);
});

test("native runtime exposes direct command toolchains to Butler and Steward sessions", async () => {
  for (const role of ["butler", "steward"] as const) {
    const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
    const executedTools: string[] = [];
    let sawCommandTool = false;
    let maxToolRounds: number | undefined;
    const runtime = new NativeToolLoopRuntime({
      disableAutomaticRecall: true,
      messageLanguage: "ko",
      executeButlerTool: async (call) => {
        executedTools.push(call.name);
        return {
          ok: true,
          command: call.args.command,
          cwd: tempDir,
          exit_code: 0,
          timed_out: false,
          stdout: "command-output",
          stderr: "",
        };
      },
      runFunctionToolPromptText: async (input) => {
        sawCommandTool = input.tools.some((tool) => tool.name === "run_command");
        maxToolRounds = input.maxToolRounds;
        await input.onAssistantTextBeforeTools?.({
          text: "summary: 현재 작업공간에서 필요한 데이터를 명령으로 확인합니다.\nrationale: 파일 기반 검증이 필요합니다.\nnext_step: 명령 출력으로 결과를 정리합니다.",
          toolCalls: [{ name: "run_command", args: { command: "pwd" } }],
        });
        await input.executeTool({
          name: "run_command",
          args: { command: "pwd" },
          rawArguments: JSON.stringify({ command: "pwd" }),
        });
        return "명령 실행 결과를 확인했습니다.";
      },
    });
    const handle = await runtime.createSession({
      sessionId: `${role}/command-test`,
      role,
      workspacePath: tempDir,
      systemPrompt: "You are Butler.",
    });

    const result = await runtime.runTurn({
      handle,
      provider: fakeProvider,
      model: "openai/auto:codex-latest",
      input: { text: "현재 작업공간을 확인해줘" },
      metadata: {
        runtimePolicy: {
          completionReview: "disabled",
          requiredNativeToolProfiles: ["workspace"],
        },
      },
      emitTurnEvent: (event) => {
        events.push({ kind: event.kind, payload: event.payload });
      },
    });

    expect(result.text).toBe("명령 실행 결과를 확인했습니다.");
    expect(sawCommandTool).toBe(true);
    expect(maxToolRounds).toBe(60);
    expect(executedTools).toEqual(["run_command"]);
    expect(events.find((event) => event.kind === "work.block.started")?.payload?.activityKind)
      .toBe("ran_command");
    expect(events.find((event) => event.kind === "tool.started")?.payload?.toolName)
      .toBe("Bash");
    expect(events.find((event) => event.kind === "tool.started")?.payload?.safeLabel)
      .toBe("Bash: pwd");
  }
});

test("native runtime advances durable WorkStreams for Steward non-trivial work", async () => {
  const defaultExecutor = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    workspacePath: tempDir,
    sessionId: "steward/workstream-custody",
    projectId: "butler",
  });
  const runtime = new NativeToolLoopRuntime({
    butlerHome: tempDir,
    butlerData: tempDir,
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: defaultExecutor,
    runFunctionToolPromptText: async (input) => {
      await input.onAssistantTextBeforeTools?.({
        text: "summary: Steward custody turn을 WorkStream으로 정리합니다.\nrationale: 비 trivial steward work도 BTCC 상태로 남아야 합니다.\nnext_step: 생성된 WorkStream을 확인합니다.",
        toolCalls: [{ name: "update_todo_list", args: { title: "Steward custody review", todos: [] } }],
      });
      await input.executeTool({
        name: "update_todo_list",
        args: {
          title: "Steward custody review",
          todos: [{
            id: "review",
            content: "Review custody evidence",
            active_form: "Reviewing custody evidence",
            status: "in_progress",
            phase: "review",
          }],
        },
        rawArguments: JSON.stringify({
          title: "Steward custody review",
          todos: [{
            id: "review",
            content: "Review custody evidence",
            active_form: "Reviewing custody evidence",
            status: "in_progress",
            phase: "review",
          }],
        }),
      });
      return "Steward custody review is underway.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "steward/workstream-custody",
    role: "steward",
    workspacePath: tempDir,
    systemPrompt: "You are Steward.",
    metadata: { projectId: "butler" },
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "프로젝트 custody 상태를 검토해줘" },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(result.text).toContain("아직 완료라고 보고할 수 있는 상태까지는 도달하지 못했습니다.");

  const streams = new WorkStreamStore(tempDir).list({
    sessionId: "steward/workstream-custody",
    includeTerminal: true,
  });
  expect(streams[0]).toMatchObject({
    owner_session_id: "steward/workstream-custody",
    project_id: "butler",
    title: "Steward custody review",
    current_phase: "review",
  });
  expect(streams[0]!.state).toBe("recoverable");
});

test("native runtime sends a profiled tool surface for basic project turns", async () => {
  let toolNames: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runFunctionToolPromptText: async (input) => {
      toolNames = input.tools.map((tool) => tool.name);
      return "프로젝트 상태를 확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/project-tool-profile",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
    metadata: { projectId: "butler" },
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      text: "Project Ledger 기준으로 상태를 확인해줘.",
    },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(toolNames).toEqual([
    "inspect_project_status",
    "query_project_work",
    "render_project_dashboard",
    "complete_project_work",
    "get_context_monitor",
    "list_tool_capabilities",
    "tool_search",
    "tool_describe",
    "tool_call",
    "update_todo_list",
    "list_todo_list",
    "read_conversation_context",
  ]);
  expect(toolNames).not.toContain("run_command");
  expect(toolNames).not.toContain("read_tool_output_artifact");
  expect(toolNames).not.toContain("get_weather_with_knowhow");
  expect(toolNames).not.toContain("create_automation");
  expect(toolNames).not.toContain("call_mcp_tool");
  expect(toolNames).not.toContain("create_planned_task");
  expect(toolNames).not.toContain("create_work_orchestration");
});

test("native runtime exposes workspace tools when structured policy requires them", async () => {
  let toolNames: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runFunctionToolPromptText: async (input) => {
      toolNames = input.tools.map((tool) => tool.name);
      return "프로젝트 작업을 처리했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/project-tool-profile-required-workspace",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
    metadata: { projectId: "butler" },
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      text: "Project Ledger에 Work와 Task를 등록하고 GitHub issue와 연결해줘.",
    },
    metadata: {
      runtimePolicy: {
        completionReview: "disabled",
        requiredNativeToolProfiles: ["workspace"],
      },
    },
  });

  expect(toolNames).toEqual(expect.arrayContaining([
    "inspect_project_status",
    "run_command",
    "read_tool_output_artifact",
    "list_tool_capabilities",
  ]));
  expect(toolNames).not.toContain("create_automation");
  expect(toolNames).not.toContain("call_mcp_tool");
});

test("native runtime attaches turn budget attribution to direct tool prompts", async () => {
  const captured: Array<{
    maxToolRounds?: number;
    butlerData?: string;
    usageAttribution?: {
      turnId?: string;
      phase?: string;
      budgetState?: { status: string; requestCount: number; maxRequests: number };
      getBudgetState?: () => { status: string; requestCount: number; maxRequests: number };
      beforeModelRequest?: (input: { roundIndex: number }) => void;
      promptSections?: Array<{ id: string; chars: number; estimatedTokens: number }>;
    };
  }> = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    butlerData: tempDir,
    runFunctionToolPromptText: async (input) => {
      input.usageAttribution?.beforeModelRequest?.({ roundIndex: 0 });
      captured.push({
        maxToolRounds: input.maxToolRounds,
        butlerData: input.butlerData,
        usageAttribution: input.usageAttribution,
      });
      return "예산 attribution을 확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/token-budget",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "토큰 예산 attribution을 확인해줘." },
    metadata: {
      turnId: "turn-budget-1",
      promptContext: "## Project Ledger Runtime Context\nstatus summary",
      runtimePolicy: { completionReview: "disabled" },
    },
  });

  expect(result.text).toContain("확인했습니다");
  expect(captured).toHaveLength(1);
  expect(captured[0].maxToolRounds).toBe(60);
  expect(captured[0].butlerData).toBe(tempDir);
  expect(captured[0].usageAttribution).toMatchObject({
    turnId: "turn-budget-1",
    phase: "initial_tool_loop",
    budgetState: {
      status: "ok",
      requestCount: 0,
      maxRequests: 32,
    },
  });
  expect(captured[0].usageAttribution?.getBudgetState?.()).toMatchObject({
    status: "ok",
    requestCount: 1,
    maxRequests: 32,
  });
  expect(captured[0].usageAttribution?.promptSections?.some((section) =>
    section.id === "prompt_context" &&
    section.chars > 0 &&
    section.estimatedTokens > 0,
  )).toBe(true);
});

test("native runtime blocks repeated Project Ledger status command families in one turn", async () => {
  const executed: string[] = [];
  const guardedResults: unknown[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    butlerData: tempDir,
    executeButlerTool: async (call) => {
      if (call.name === "run_command" && typeof call.args.command === "string") {
        executed.push(call.args.command);
      }
      return {
        ok: true,
        stdout: "fresh evidence",
        stderr: "",
        exit_code: 0,
        timed_out: false,
      };
    },
    runFunctionToolPromptText: async (input) => {
      for (let index = 0; index < 4; index += 1) {
        guardedResults.push(await input.executeTool({
          name: "run_command",
          args: { command: "packages/project-ledger/bin/project-ledger status --project . --json" },
          rawArguments: JSON.stringify({
            command: "packages/project-ledger/bin/project-ledger status --project . --json",
          }),
        }));
      }
      return "반복 상태 확인을 중단했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/repeat-budget",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "원장 상태를 반복 확인해줘." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(result.text).toContain("중단했습니다");
  expect(executed).toHaveLength(3);
  expect(guardedResults[3]).toMatchObject({
    ok: false,
    budget_policy: "repeated_tool_family_blocked",
    repeat_family: "project-ledger:status",
    repeat_count: 4,
    repeat_limit: 3,
  });
});

test("native runtime reports high provider usage without stopping the next model call", async () => {
  let beforeModelRequests = 0;
  let stateAfterHighUsage: {
    status: string;
    requestCount: number;
    promptTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | undefined;
  let stateAfterSecondRequest: {
    status: string;
    requestCount: number;
    promptTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | undefined;
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    butlerData: tempDir,
    runFunctionToolPromptText: async (input) => {
      input.usageAttribution?.beforeModelRequest?.({ roundIndex: 0 });
      beforeModelRequests += 1;
      input.usageAttribution?.afterModelResponseUsage?.({
        model: "openai/auto:codex-latest",
        promptTokens: 221_000,
        cachedTokens: 0,
        outputTokens: 1_000,
        totalTokens: 222_000,
        roundIndex: 0,
      });
      stateAfterHighUsage = input.usageAttribution?.getBudgetState?.();
      input.usageAttribution?.beforeModelRequest?.({ roundIndex: 1 });
      beforeModelRequests += 1;
      stateAfterSecondRequest = input.usageAttribution?.getBudgetState?.();
      return "높은 토큰 사용량을 기록하고 계속 진행했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/token-cap",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "토큰 사용량이 높아도 진단만 기록하고 계속 진행해줘." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(result.text).toContain("계속 진행했습니다");
  expect(beforeModelRequests).toBe(2);
  expect(stateAfterHighUsage).toMatchObject({
    status: "warning",
    requestCount: 1,
    promptTokens: 221_000,
    outputTokens: 1_000,
    totalTokens: 222_000,
  });
  expect(stateAfterSecondRequest).toMatchObject({
    status: "warning",
    requestCount: 2,
    promptTokens: 221_000,
    outputTokens: 1_000,
    totalTokens: 222_000,
  });
});

test("native runtime allows repeated tests after a state-mutating command resets repeat guards", async () => {
  const executed: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    butlerData: tempDir,
    executeButlerTool: async (call) => {
      if (call.name === "run_command" && typeof call.args.command === "string") {
        executed.push(call.args.command);
      }
      return {
        ok: true,
        stdout: "ok",
        stderr: "",
        exit_code: 0,
        timed_out: false,
      };
    },
    runFunctionToolPromptText: async (input) => {
      for (const command of [
        "bun test tests/unit/native-tool-loop-runtime.test.ts",
        "bun test tests/unit/native-tool-loop-runtime.test.ts",
        "bun test tests/unit/native-tool-loop-runtime.test.ts",
        "printf 'changed' > packages/butler-agent/src/__budget-reset-test.txt",
        "bun test tests/unit/native-tool-loop-runtime.test.ts",
      ]) {
        await input.executeTool({
          name: "run_command",
          args: { command },
          rawArguments: JSON.stringify({ command }),
        });
      }
      return "변경 후 테스트 재실행을 허용했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/repeat-reset",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "테스트를 반복하고 수정 후 다시 실행해줘." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(result.text).toContain("허용했습니다");
  expect(executed).toHaveLength(5);
});

test("native runtime can drive the real run_command tool through the default executor", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const runtime = new NativeToolLoopRuntime({
    butlerHome: process.cwd(),
    butlerData: tempDir,
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    runFunctionToolPromptText: async (input) => {
      await input.onAssistantTextBeforeTools?.({
        text: "summary: 워크스페이스 안에서 검증 파일을 생성합니다.\nrationale: 직접 명령 도구가 실제 파일 작업까지 수행하는지 확인해야 합니다.\nnext_step: 생성된 파일을 근거로 결과를 보고합니다.",
        toolCalls: [{
          name: "run_command",
          args: {
            command: "printf 'ok\\n' > command-proof.txt && cat command-proof.txt",
            output_paths: ["command-proof.txt"],
          },
        }],
      });
      const args = {
        command: "printf 'ok\\n' > command-proof.txt && cat command-proof.txt",
        output_paths: ["command-proof.txt"],
      };
      const result = await input.executeTool({
        name: "run_command",
        args,
        rawArguments: JSON.stringify(args),
      }) as { stdout?: string };
      expect(result.stdout).toContain("ok");
      return "검증 파일을 만들고 확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/real-command-test",
    role: "butler",
    workspacePath: workspace,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "직접 명령 도구를 실제로 실행해줘" },
    emitTurnEvent: (event) => {
      events.push({ kind: event.kind, payload: event.payload });
    },
  });

  expect(result.text).toBe("검증 파일을 만들고 확인했습니다.");
  expect(readFileSync(join(workspace, "command-proof.txt"), "utf8")).toBe("ok\n");
  expect(result.artifacts?.[0]).toMatchObject({
    title: "command-proof.txt",
    safePathLabel: "command-proof.txt",
    localPath: join(workspace, "command-proof.txt"),
    kind: "file",
  });
  expect(events.find((event) => event.kind === "tool.started")?.payload?.toolName)
    .toBe("Bash");
});

test("native runtime resolves run_command generated artifacts from Butler data", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const runtime = new NativeToolLoopRuntime({
    butlerHome: process.cwd(),
    butlerData: tempDir,
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    runFunctionToolPromptText: async (input) => {
      const command =
        "mkdir -p \"$BUTLER_ARTIFACTS_DIR/cyrene\"; printf 'name,count\\ncyrene,1\\n' > \"$BUTLER_ARTIFACTS_DIR/cyrene/report.csv\"";
      const result = await input.executeTool({
        name: "run_command",
        args: { command },
        rawArguments: JSON.stringify({ command }),
      }) as { artifact_label?: string };
      expect(result.artifact_label).toBe("artifacts/generated/cyrene/report.csv");
      return "데이터 홈 아티팩트를 만들었습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/generated-artifact-test",
    role: "butler",
    workspacePath: workspace,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "생성 아티팩트를 만들어줘" },
  });

  const artifactPath = join(tempDir, "artifacts", "generated", "cyrene", "report.csv");
  expect(result.text).toBe("데이터 홈 아티팩트를 만들었습니다.");
  expect(readFileSync(artifactPath, "utf8")).toContain("cyrene,1");
  expect(existsSync(join(workspace, "artifacts"))).toBe(false);
  expect(result.artifacts?.[0]).toMatchObject({
    title: "report.csv",
    safePathLabel: "artifacts/generated/cyrene/report.csv",
    localPath: artifactPath,
    kind: "csv_file",
  });
});

test("native runtime uses the web search query in public work labels when safe", async () => {
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async () => ({ ok: true, outputText: "safe result" }),
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "web_search",
        args: { query: "충주 5월 축제" },
        rawArguments: JSON.stringify({ query: "충주 5월 축제" }),
      });
      return "검색했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "충주 축제를 찾아줘" },
    emitTurnEvent: (event) => {
      events.push({ kind: event.kind, payload: event.payload });
    },
  });

  expect(events.find((event) => event.kind === "work.block.started")?.payload?.label)
    .toBe('공개 웹에서 "충주 5월 축제" 관련 정보를 검색합니다.');
  expect(events.find((event) => event.kind === "work.block.started")?.payload?.label)
    .not.toBe("공개 웹에서 필요한 정보를 검색합니다.");
  expect(events.find((event) => event.kind === "tool.started")?.payload?.safeLabel)
    .toBe("Web search: 충주 5월 축제");
});

test("native runtime falls back only when web search has no safe query label", async () => {
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "en",
    executeButlerTool: async () => ({ ok: true, outputText: "safe result" }),
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "web_search",
        args: {},
        rawArguments: "{}",
      });
      await input.executeTool({
        name: "web_search",
        args: { query: "query" },
        rawArguments: JSON.stringify({ query: "query" }),
      });
      return "Checked.\n\nSources: https://example.test/search";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "search twice" },
    emitTurnEvent: (event) => {
      events.push({ kind: event.kind, payload: event.payload });
    },
  });

  const workBlockLabels = events
    .filter((event) => event.kind === "work.block.started")
    .map((event) => event.payload?.label);
  expect(workBlockLabels.slice(0, 2))
    .toEqual([
      "Searching public web sources for the needed information.",
      "Searching public web sources for query.",
    ]);
  const toolLabels = events
    .filter((event) => event.kind === "tool.started")
    .map((event) => event.payload?.safeLabel);
  expect(toolLabels.slice(0, 2)).toEqual(["Web search", "Web search: query"]);
});

test("native runtime describes Project Ledger tool progress by work context", async () => {
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const workspacePath = join(tempDir, "workspace");
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "en",
    executeButlerTool: async () => ({ ok: true }),
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "inspect_project_status",
        args: { project_path: workspacePath },
        rawArguments: JSON.stringify({ project_path: workspacePath }),
      });
      await input.executeTool({
        name: "query_project_work",
        args: { project_path: workspacePath, kind: "next-actions" },
        rawArguments: JSON.stringify({ project_path: workspacePath, kind: "next-actions" }),
      });
      await input.executeTool({
        name: "render_project_dashboard",
        args: { project_path: workspacePath, view: "dashboard", write: true },
        rawArguments: JSON.stringify({ project_path: workspacePath, view: "dashboard", write: true }),
      });
      return "Project Ledger dashboard is ready.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "로컬 Project Ledger 상태를 확인하고 대시보드를 갱신해줘" },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
    emitTurnEvent: (event) => {
      events.push({ kind: event.kind, payload: event.payload });
    },
  });

  const labels = events
    .filter((event) => event.kind === "tool.started")
    .map((event) => event.payload?.safeLabel);
  expect(labels).toEqual([
    "Checking local Project Ledger status",
    "Reviewing Project Ledger next actions",
    "Rendering Project Ledger dashboard view",
  ]);
  const workBlockEvents = events.filter((event) => event.kind.startsWith("work.block."));
  expect(workBlockEvents).toHaveLength(6);
  expect(workBlockEvents.map((event) => event.payload?.label)).toEqual([
    "Checking the Project Ledger status.",
    "Checking the Project Ledger status.",
    "Reviewing the needed Project Ledger work context.",
    "Reviewing the needed Project Ledger work context.",
    "Updating the Project Ledger dashboard.",
    "Updating the Project Ledger dashboard.",
  ]);
  const projectLedgerToolEvents = events.filter((item) =>
    item.kind.startsWith("tool.") && item.payload?.activityKind !== "model",
  );
  for (const event of projectLedgerToolEvents) {
    expect(event.payload?.workBlockId).toBeTruthy();
    expect(event.payload?.workBlockLabel).not.toBe(event.payload?.safeLabel);
    expect(String(event.payload?.workBlockLabel)).not.toContain("inspect_project_status");
  }
  const publicToolEvents = JSON.stringify(projectLedgerToolEvents);
  expect(publicToolEvents).toContain("Project Ledger");
  expect(publicToolEvents).not.toContain("inspect_project_status");
  expect(publicToolEvents).not.toContain("query_project_work");
  expect(publicToolEvents).not.toContain("render_project_dashboard");
});

test("native runtime caches Project Ledger reads only until a same-turn mutation", async () => {
  let ledgerVersion = 1;
  let statusExecutions = 0;
  let queryExecutions = 0;
  const observedVersions: number[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "en",
    butlerData: tempDir,
    butlerHome: tempDir,
    executeButlerTool: async (call) => {
      if (call.name === "update_todo_list") return { ok: true };
      if (call.name === "inspect_project_status") {
        statusExecutions += 1;
        return { ok: true, ledgerVersion, tool: call.name };
      }
      if (call.name === "query_project_work") {
        queryExecutions += 1;
        return { ok: true, ledgerVersion, tool: call.name };
      }
      if (call.name === "run_command") {
        const command = typeof call.args.command === "string" ? call.args.command : "";
        if (command.includes("project-ledger task update")) ledgerVersion += 1;
        return { ok: true, exit_code: 0, stdout: "updated", stderr: "", timed_out: false };
      }
      return { ok: true };
    },
    runFunctionToolPromptText: async (input) => {
      const firstStatus = await input.executeTool({
        name: "inspect_project_status",
        args: { project_path: tempDir },
        rawArguments: JSON.stringify({ project_path: tempDir }),
      }) as Record<string, unknown>;
      const cachedStatus = await input.executeTool({
        name: "inspect_project_status",
        args: { project_path: tempDir },
        rawArguments: JSON.stringify({ project_path: tempDir }),
      }) as Record<string, unknown>;
      const firstQuery = await input.executeTool({
        name: "query_project_work",
        args: { project_path: tempDir, kind: "next-actions" },
        rawArguments: JSON.stringify({ project_path: tempDir, kind: "next-actions" }),
      }) as Record<string, unknown>;
      const cachedQuery = await input.executeTool({
        name: "query_project_work",
        args: { project_path: tempDir, kind: "next-actions" },
        rawArguments: JSON.stringify({ project_path: tempDir, kind: "next-actions" }),
      }) as Record<string, unknown>;
      await input.executeTool({
        name: "run_command",
        args: {
          command: "node packages/project-ledger/bin/project-ledger task update --project \"$PWD\" --id T-1 --status in_progress",
        },
        rawArguments: JSON.stringify({
          command: "node packages/project-ledger/bin/project-ledger task update --project \"$PWD\" --id T-1 --status in_progress",
        }),
      });
      const statusAfterMutation = await input.executeTool({
        name: "inspect_project_status",
        args: { project_path: tempDir },
        rawArguments: JSON.stringify({ project_path: tempDir }),
      }) as Record<string, unknown>;
      observedVersions.push(
        Number(firstStatus.ledgerVersion),
        Number(cachedStatus.ledgerVersion),
        Number(firstQuery.ledgerVersion),
        Number(cachedQuery.ledgerVersion),
        Number(statusAfterMutation.ledgerVersion),
      );
      return "Project Ledger freshness checked.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/project-ledger-turn-cache",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "Project Ledger 상태를 확인하고 변경 후 다시 확인해줘." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(observedVersions).toEqual([1, 1, 1, 1, 2]);
  expect(statusExecutions).toBe(2);
  expect(queryExecutions).toBe(1);
});

test("native runtime uses assistant-authored public decisions as work block context", async () => {
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  let returnedToolResult: unknown;
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async () => ({ ok: true, results: [{ title: "충주 행사", url: "https://example.test/chungju" }] }),
    runFunctionToolPromptText: async (input) => {
      await input.onAssistantTextBeforeTools?.({
        text: [
          "summary: 충주 행사 데이터를 공식 출처 위주로 먼저 확인합니다.",
          "rationale: 보고서의 표와 추천이 추측이 아니라 공개 근거에 기대야 하기 때문입니다.",
          "next_step: 확인한 결과를 정제 단계의 입력 후보로 사용합니다.",
        ].join("\n"),
        toolCalls: [{
          name: "web_search",
          args: { query: "충주 행사 2026" },
        }],
      });
      returnedToolResult = await input.executeTool({
        name: "web_search",
        args: { query: "충주 행사 2026" },
        rawArguments: JSON.stringify({ query: "충주 행사 2026" }),
      });
      return "공개 출처를 기준으로 확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "충주 행사 데이터를 찾아서 보고해줘" },
    emitTurnEvent: (event) => {
      events.push({ kind: event.kind, payload: event.payload });
    },
  });

  expect(result.text).toContain("공개 출처를 기준으로 확인했습니다.");
  const workStart = events.find((event) => event.kind === "work.block.started");
  expect(workStart?.payload).toMatchObject({
    label: "충주 행사 데이터를 공식 출처 위주로 먼저 확인합니다.",
    decisionSummary: "충주 행사 데이터를 공식 출처 위주로 먼저 확인합니다.",
    decisionRationale: "보고서의 표와 추천이 추측이 아니라 공개 근거에 기대야 하기 때문입니다.",
    decisionNextStep: "확인한 결과를 정제 단계의 입력 후보로 사용합니다.",
    decisionSource: "assistant-authored",
  });
  expect(workStart?.payload?.label).not.toBe('공개 웹에서 "충주 행사 2026" 관련 정보를 검색합니다.');
  expect(events.find((event) => event.kind === "tool.started")?.payload?.workBlockLabel)
    .toBe("충주 행사 데이터를 공식 출처 위주로 먼저 확인합니다.");
  expect(JSON.stringify(returnedToolResult)).toContain("public_work_decision_context");
  expect(JSON.stringify(returnedToolResult)).toContain("충주 행사 데이터를 공식 출처 위주로 먼저 확인합니다.");
});

test("native runtime rejects unsafe assistant-authored public decisions before tool rows", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-native-tools-unsafe-decision-"));
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  try {
    const runtime = new NativeToolLoopRuntime({
      disableAutomaticRecall: true,
      messageLanguage: "ko",
      executeButlerTool: async () => ({ ok: true, results: [{ title: "충주 행사", url: "https://example.test/chungju" }] }),
      runFunctionToolPromptText: async (input) => {
        await input.onAssistantTextBeforeTools?.({
          text: [
            "summary: FileNotFoundException own tool output artifact root_path = /tmp/butler-workers/task/result.md not found.",
            "rationale: /Users/example/private/raw-payload.json을 확인해야 합니다.",
          ].join("\n"),
          toolCalls: [{
            name: "web_search",
            args: { query: "충주 행사 2026" },
          }],
        });
        await input.executeTool({
          name: "web_search",
          args: { query: "충주 행사 2026" },
          rawArguments: JSON.stringify({ query: "충주 행사 2026" }),
        });
        return "공개 출처를 기준으로 확인했습니다.";
      },
    });
    const handle = await runtime.createSession({
      sessionId: "butler/main",
      role: "butler",
      workspacePath: tempDir,
      systemPrompt: "You are Butler.",
    });

    await runtime.runTurn({
      handle,
      provider: fakeProvider,
      model: "openai/auto:codex-latest",
      input: { text: "충주 행사 데이터를 찾아서 보고해줘" },
      emitTurnEvent: (event) => {
        events.push({ kind: event.kind, payload: event.payload });
      },
    });

    const workStart = events.find((event) => event.kind === "work.block.started");
    expect(workStart?.payload?.decisionSource).toBe("runtime-derived");
    expect(JSON.stringify(workStart?.payload ?? {})).not.toContain("FileNotFoundException");
    expect(JSON.stringify(workStart?.payload ?? {})).not.toContain("root_path");
    expect(JSON.stringify(workStart?.payload ?? {})).not.toContain("/tmp/butler-workers");
    expect(JSON.stringify(workStart?.payload ?? {})).not.toContain("/Users/example");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("native runtime preserves safe public decision fields when repairing unsafe summaries", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-native-tools-repaired-decision-"));
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  try {
    const runtime = new NativeToolLoopRuntime({
      disableAutomaticRecall: true,
      messageLanguage: "ko",
      executeButlerTool: async () => ({ ok: true, source: "public" }),
      runFunctionToolPromptText: async (input) => {
        await input.onAssistantTextBeforeTools?.({
          text: [
            "summary: FileNotFoundException own tool output artifact root_path = /tmp/butler-workers/task/result.md not found.",
            "rationale: 선택한 공개 출처의 본문 근거를 확인해야 하기 때문입니다.",
            "next_step: 확인한 근거를 표 정제 단계의 입력으로 사용합니다.",
          ].join("\n"),
          toolCalls: [{
            name: "web_read",
            args: { url: "https://example.test/chungju" },
          }],
        });
        await input.executeTool({
          name: "web_read",
          args: { url: "https://example.test/chungju" },
          rawArguments: JSON.stringify({ url: "https://example.test/chungju" }),
        });
        return "공개 출처를 기준으로 확인했습니다.";
      },
    });
    const handle = await runtime.createSession({
      sessionId: "butler/main",
      role: "butler",
      workspacePath: tempDir,
      systemPrompt: "You are Butler.",
    });

    await runtime.runTurn({
      handle,
      provider: fakeProvider,
      model: "openai/auto:codex-latest",
      input: { text: "충주 행사 데이터를 찾아서 보고해줘" },
      emitTurnEvent: (event) => {
        events.push({ kind: event.kind, payload: event.payload });
      },
    });

    const workStart = events.find((event) => event.kind === "work.block.started");
    expect(workStart?.payload?.decisionSource).toBe("review-repaired");
    expect(workStart?.payload?.decisionSummary).not.toContain("FileNotFoundException");
    expect(workStart?.payload?.decisionRationale).toBe("선택한 공개 출처의 본문 근거를 확인해야 하기 때문입니다.");
    expect(workStart?.payload?.decisionNextStep).toBe("확인한 근거를 표 정제 단계의 입력으로 사용합니다.");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("native runtime derives fallback work decision for non-canonical pre-tool prose", async () => {
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async () => ({
      ok: true,
      source_url: "https://example.test/population",
      text: "서울 930만, 부산 326만, 인천 302만",
    }),
    runFunctionToolPromptText: async (input) => {
      await input.onAssistantTextBeforeTools?.({
        text: "s",
        toolCalls: [{ name: "web_read", args: { url: "https://example.test/population" } }],
      });
      await input.executeTool({
        name: "web_read",
        args: { url: "https://example.test/population" },
        rawArguments: JSON.stringify({ url: "https://example.test/population" }),
      });
      return "공개 출처를 기준으로 확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "local/gemma-4",
    input: { text: "공개 출처를 읽고 보고해줘" },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
    emitTurnEvent: (event) => {
      events.push({ kind: event.kind, payload: event.payload });
    },
  });

  const workStart = events.find((event) => event.kind === "work.block.started");
  expect(workStart?.payload?.decisionSource).toBe("runtime-derived");
  expect(workStart?.payload?.decisionSummary).toBe("선택한 출처의 내용을 확인합니다.");
  expect(workStart?.payload?.decisionSummary).not.toBe("s");
});

test("native runtime carries public decision context across dependent tool calls", async () => {
  const returnedToolResults: unknown[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async (call) => ({ ok: true, tool: call.name }),
    runFunctionToolPromptText: async (input) => {
      await input.onAssistantTextBeforeTools?.({
        text: [
          "summary: 접근 가능한 공개 자료 후보를 먼저 수집합니다.",
          "rationale: 중간 변환에 넣을 원자료가 있어야 보고서가 성립합니다.",
          "next_step: 후보 중 읽을 수 있는 출처를 고릅니다.",
        ].join("\n"),
        toolCalls: [{ name: "web_search", args: { query: "충주 열린데이터 행사" } }],
      });
      returnedToolResults.push(await input.executeTool({
        name: "web_search",
        args: { query: "충주 열린데이터 행사" },
        rawArguments: JSON.stringify({ query: "충주 열린데이터 행사" }),
      }));

      expect(JSON.stringify(returnedToolResults.at(-1))).toContain("접근 가능한 공개 자료 후보를 먼저 수집합니다.");
      await input.onAssistantTextBeforeTools?.({
        text: [
          "summary: 첫 자료 후보에서 본문 근거를 읽어 원자료 필드를 확인합니다.",
          "rationale: 검색 요약만으로는 CSV로 정제할 필드가 충분하지 않습니다.",
          "next_step: 읽은 필드를 기준으로 로컬 정제 작업을 수행합니다.",
        ].join("\n"),
        toolCalls: [{ name: "web_read", args: { url: "https://example.test/events" } }],
      });
      returnedToolResults.push(await input.executeTool({
        name: "web_read",
        args: { url: "https://example.test/events" },
        rawArguments: JSON.stringify({ url: "https://example.test/events" }),
      }));

      await input.onAssistantTextBeforeTools?.({
        text: [
          "summary: 확인된 필드를 작은 CSV 형태로 정제합니다.",
          "rationale: 최종 보고 전에 행과 열을 고정해야 누락을 점검할 수 있습니다.",
          "next_step: 정제된 표를 기준으로 핵심 결과를 보고합니다.",
        ].join("\n"),
        toolCalls: [{ name: "render_project_dashboard", args: { project_path: tempDir, view: "dashboard", write: true } }],
      });
      returnedToolResults.push(await input.executeTool({
        name: "render_project_dashboard",
        args: { project_path: tempDir, view: "dashboard", write: true },
        rawArguments: JSON.stringify({ project_path: tempDir, view: "dashboard", write: true }),
      }));

      return "수집한 공개 자료를 읽고 정제 기준까지 반영해 보고했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "공개 자료를 수집하고 정제해서 보고해줘" },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  const finalToolResult = JSON.stringify(returnedToolResults.at(-1));
  expect(finalToolResult).toContain("## Public Work Decisions");
  expect(finalToolResult).toContain("접근 가능한 공개 자료 후보를 먼저 수집합니다.");
  expect(finalToolResult).toContain("첫 자료 후보에서 본문 근거를 읽어 원자료 필드를 확인합니다.");
  expect(finalToolResult).toContain("확인된 필드를 작은 CSV 형태로 정제합니다.");
  const transcript = readTranscript("butler/main")
    .filter((event) => event.kind === "system" && event.payload.category === "public_work_decision");
  expect(transcript).toHaveLength(3);
  expect(JSON.stringify(transcript)).not.toContain("chain-of-thought");
});

test("native runtime records decision metrics without storing decision text", async () => {
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async () => ({ ok: true }),
    runFunctionToolPromptText: async (input) => {
      await input.onAssistantTextBeforeTools?.({
        text: [
          "summary: SECRET_DECISION_TEXT 공개 자료 후보를 확인합니다.",
          "rationale: SECRET_DECISION_TEXT 원자료가 있어야 표 정제를 할 수 있습니다.",
          "next_step: SECRET_DECISION_TEXT 확인 결과를 다음 단계 입력으로 씁니다.",
        ].join("\n"),
        toolCalls: [{ name: "web_search", args: { query: "public data" } }],
      });
      await input.executeTool({
        name: "web_search",
        args: { query: "public data" },
        rawArguments: JSON.stringify({ query: "public data" }),
      });
      return "공개 자료 확인을 마쳤습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "공개 자료를 확인해줘" },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  const turnMetric = readOperationalMetricEvents({ butlerData: tempDir })
    .find((event) => event.category === "runtime" && event.name === "turn");
  expect(turnMetric?.dimensions).toMatchObject({
    publicDecisions: 1,
    publicDecisionAssistantAuthored: 1,
    publicDecisionRuntimeDerived: 0,
  });
  expect(turnMetric?.rawTextStored).toBe(false);
  const rawMetrics = readFileSync(operationalMetricsPath(tempDir), "utf8");
  expect(rawMetrics).not.toContain("SECRET_DECISION_TEXT");
});

test("native runtime repairs turns that skip explicitly required tools", async () => {
  const attempts: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async (call) => ({ ok: true, tool: call.name }),
    runFunctionToolPromptText: async (input) => {
      attempts.push(input.prompt);
      if (attempts.length === 1) {
        await input.onAssistantTextBeforeTools?.({
          text: "summary: 공개 자료 후보를 찾습니다.\nrationale: 표 정제 전 원자료가 필요합니다.\nnext_step: 읽을 출처를 고릅니다.",
          toolCalls: [{ name: "web_search", args: { query: "한국 도시 인구" } }],
        });
        await input.executeTool({
          name: "web_search",
          args: { query: "한국 도시 인구" },
          rawArguments: JSON.stringify({ query: "한국 도시 인구" }),
        });
        return "검색만 하고 마쳤습니다.";
      }
      if (input.prompt.includes("Explicit Tool Requirement Repair")) {
        expect(input.prompt).toContain("transform_public_data_table");
        await input.onAssistantTextBeforeTools?.({
          text: "summary: 필수 표 정제 단계를 완료합니다.\nrationale: 사용자가 CSV 표 생성을 필수로 요구했습니다.\nnext_step: 정제 표를 기준으로 결과만 보고합니다.",
          toolCalls: [{ name: "transform_public_data_table", args: { columns: ["city"], rows: [{ city: "Seoul" }] } }],
        });
        await input.executeTool({
          name: "transform_public_data_table",
          args: { columns: ["city"], rows: [{ city: "Seoul" }] },
          rawArguments: JSON.stringify({ columns: ["city"], rows: [{ city: "Seoul" }] }),
        });
        return "필수 표 정제를 마쳤습니다.";
      }
      expect(input.prompt).toContain("Goal Completion Review");
      return "필수 표 정제를 마쳤습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "반드시 web_search와 transform_public_data_table을 사용해서 보고해줘" },
    metadata: { requiredNativeTools: ["web_search", "transform_public_data_table"] },
  });

  expect(attempts.length).toBeGreaterThanOrEqual(2);
  expect(result.text).toBe("필수 표 정제를 마쳤습니다.");
  expect(readTranscript("butler/main")
    .filter((event) => event.kind === "tool_call")
    .map((event) => event.payload.name)).toEqual(expect.arrayContaining([
      "web_search",
      "transform_public_data_table",
    ]));
  const repairDecision = readTranscript("butler/main")
    .filter((event) => event.kind === "system" && event.payload.category === "public_work_decision")
    .map((event) => event.payload.decision as Record<string, unknown>)
    .find((decision) => decision.decisionSummary === "필수 표 정제 단계를 완료합니다.");
  expect(repairDecision).toMatchObject({
    decisionSummary: "필수 표 정제 단계를 완료합니다.",
    decisionRationale: "사용자가 CSV 표 생성을 필수로 요구했습니다.",
    decisionNextStep: "정제 표를 기준으로 결과만 보고합니다.",
    decisionSource: "assistant-authored",
  });
});

test("native runtime repairs skipped tools required by session metadata", async () => {
  const attempts: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async (call) => ({ ok: true, tool: call.name }),
    runFunctionToolPromptText: async (input) => {
      attempts.push(input.prompt);
      if (attempts.length === 1) {
        return "명령 실행 없이 마쳤습니다.";
      }
      expect(input.prompt).toContain("Explicit Tool Requirement Repair");
      expect(input.prompt).toContain("run_command");
      await input.onAssistantTextBeforeTools?.({
        text: "summary: 필수 명령 실행을 완료합니다.\nrationale: 세션 정책이 run_command를 요구했습니다.\nnext_step: 실행 결과만 요약합니다.",
        toolCalls: [{ name: "run_command", args: { command: "pwd" } }],
      });
      await input.executeTool({
        name: "run_command",
        args: { command: "pwd" },
        rawArguments: JSON.stringify({ command: "pwd" }),
      });
      return "필수 명령 실행을 마쳤습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/session-required-tool",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
    metadata: { runtimePolicy: { requiredNativeTools: ["run_command"] } },
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "작업을 처리해줘" },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(attempts.length).toBe(2);
  expect(result.text).toBe("필수 명령 실행을 마쳤습니다.");
  expect(readTranscript("butler/session-required-tool")
    .filter((event) => event.kind === "tool_call")
    .map((event) => event.payload.name)).toContain("run_command");
});

test("explicit required tool merging dedupes before applying the repair cap", () => {
  expect(requiredExplicitToolNames([
    { runtimePolicy: { requiredNativeTools: [
      "run_command",
      "run_command",
      "run_command",
      "run_command",
      "run_command",
      "run_command",
    ] } },
    { runtimePolicy: { requiredNativeTools: ["web_search"] } },
  ], ["run_command", "web_search"])).toEqual(["run_command", "web_search"]);
});

test("native runtime does not infer semantic workflow tools from natural CSV wording", async () => {
  const attempts: string[] = [];
  const executedTools: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      if (call.name === "web_search") {
        return {
          results: [
            { title: "주민등록 인구통계", url: "https://example.test/population" },
          ],
          source_urls: ["https://example.test/population"],
        };
      }
      if (call.name === "web_read") {
        return {
          source_url: "https://example.test/population",
          title: "주민등록 인구통계",
          text: "서울특별시 9,300,000명, 부산광역시 3,300,000명, 인천광역시 3,000,000명",
        };
      }
      return { ok: true };
    },
    runFunctionToolPromptText: async (input) => {
      attempts.push(input.prompt);
      expect(input.instructions).toContain("do not rely on request-word shortcuts or hardcoded workflow shortcuts");
      expect(input.instructions).toContain("Treat discovery/search outputs as candidates");
      expect(input.instructions).toContain("inline text is not enough");
      expect(input.instructions).toContain("specific enough for the next step to continue");
      expect(input.instructions).not.toContain("after collecting public rows");
      expect(input.prompt).not.toContain("Public Data Table Workflow Repair");
      if (attempts.length === 1) {
        await input.onAssistantTextBeforeTools?.({
          text: "summary: 한국 주요 도시의 공개 인구 통계를 검색합니다.\nrationale: 공개 출처를 먼저 확인해야 합니다.\nnext_step: 읽을 출처를 고릅니다.",
          toolCalls: [{ name: "web_search", args: { query: "대한민국 주요 도시 인구 통계" } }],
        });
        await input.executeTool({
          name: "web_search",
          args: { query: "대한민국 주요 도시 인구 통계" },
          rawArguments: JSON.stringify({ query: "대한민국 주요 도시 인구 통계" }),
        });
        await input.onAssistantTextBeforeTools?.({
          text: "summary: 선택한 공개 출처의 내용을 확인합니다.\nrationale: 검색 요약만으로는 행을 확정할 수 없습니다.\nnext_step: 확인한 수치를 최종 보고에 반영합니다.",
          toolCalls: [{ name: "web_read", args: { url: "https://example.test/population" } }],
        });
        await input.executeTool({
          name: "web_read",
          args: { url: "https://example.test/population" },
          rawArguments: JSON.stringify({ url: "https://example.test/population" }),
        });
        return "summary: 한국 주요 도시 인구 순위 조사를 위해 웹 검색을 수행합니다.\nrationale: 최신 공개 데이터를 바탕으로 정확한 상위 도시와 인구수를 확인하기 위함입니다.\nnext_step: 수집된 정보를 기반으로 3개 이상의 도시에 대한 CSV 표를 작성하고 요약 보고서를 구성하겠습니다.";
      }
      if (input.prompt.includes("Goal Completion Review")) {
        expect(input.prompt).toContain("Do not apply hardcoded rules for any specific tool");
        expect(input.prompt).toContain("This review is an action gate");
        expect(input.prompt).toContain("Attached native tool schemas are the source of truth");
        expect(input.prompt).toContain("reuse public facts, values, URLs, labels, artifact references");
        expect(input.prompt).toContain("Discovery/search evidence identifies candidates");
        expect(input.prompt).toContain("Durable deliverables require durable evidence");
        expect(input.prompt).not.toContain("transform_public_data_table");
        return "summary: 한국 주요 도시 인구 순위 조사를 위해 웹 검색을 수행합니다.\nrationale: 최신 공개 데이터를 바탕으로 정확한 상위 도시와 인구수를 확인하기 위함입니다.\nnext_step: 수집된 정보를 기반으로 3개 이상의 도시에 대한 CSV 표를 작성하고 요약 보고서를 구성하겠습니다.";
      }
      expect(input.prompt).toContain("Final Result Contract Repair");
      expect(input.prompt).toContain("`summary:`, `rationale:`, `next_step:`");
      return [
        "## 한국 주요 도시 인구 순위 샘플 보고서",
        "",
        "공개 출처를 확인한 뒤 3개 도시의 인구 순위 샘플을 정리했습니다.",
        "",
        "```csv",
        "rank,city,population",
        "1,서울특별시,9300000",
        "2,부산광역시,3300000",
        "3,인천광역시,3000000",
        "```",
      ].join("\n");
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "local/gemma-4",
    input: {
      text: "공개 웹에서 접근 가능한 자료를 바탕으로 한국 주요 도시 3곳의 인구 순위 샘플을 수집해 작은 보고서를 작성해 주세요.\n근거가 되는 공개 출처 하나 이상을 직접 확인하고, 수집한 3행 이상의 데이터를 작은 CSV 표로 정제한 뒤 결과를 요약해 주세요.",
    },
  });

  expect(attempts.some((prompt) => prompt.includes("Public Data Table Workflow Repair"))).toBe(false);
  expect(attempts.some((prompt) => prompt.includes("Goal Completion Review"))).toBe(true);
  expect(attempts.some((prompt) => prompt.includes("Final Result Contract Repair"))).toBe(true);
  expect(executedTools).toEqual(["web_search", "web_read"]);
  expect(executedTools).not.toContain("transform_public_data_table");
  expect(result.text).toContain("한국 주요 도시 인구 순위 샘플 보고서");
  expect(result.text).not.toMatch(/^\s*작업\s*[:：]/u);
});

test("final result contract detects embedded public work decision leaks", () => {
  expect(containsFinalPublicWorkDecisionLeak([
    "요약 보고서입니다.",
    "",
    "summary: 확인한 공개 자료를 정리합니다.",
    "rationale: 다음 보고의 근거를 남기기 위해서입니다.",
    "next_step: 결과만 요약합니다.",
  ].join("\n"))).toBe(true);
  expect(containsFinalToolImplementationLeak(
    "FileNotFoundException\ntransform_public_data_table created artifact.",
    ["transform_public_data_table"],
  )).toBe(true);
  expect(containsFinalToolImplementationLeak(
    "I called transform_public_data_table and then wrote the final.",
    ["transform_public_data_table"],
  )).toBe(true);
  expect(containsFinalToolImplementationLeak([
    "Answer line 1: recall_memory: current associative recall tool; input field cue.",
    "Answer line 2: query_memory: exact durable memory/history lookup tool.",
  ].join("\n"), ["recall_memory"])).toBe(false);
  expect(stripToolImplementationLeakLines([
    "요약입니다.",
    "transform_public_data_table created artifact.",
    "completion_obligations: source_verified",
    "사용자에게 보여도 되는 결과입니다.",
  ].join("\n"), ["transform_public_data_table"])).toBe([
    "요약입니다.",
    "사용자에게 보여도 되는 결과입니다.",
  ].join("\n"));
  expect(stripToolImplementationLeakLines([
    "Answer line 1: recall_memory: current associative recall tool; input field cue.",
    "Answer line 2: query_memory: exact durable memory/history lookup tool.",
  ].join("\n"), ["recall_memory"])).toBe([
    "Answer line 1: recall_memory: current associative recall tool; input field cue.",
    "Answer line 2: query_memory: exact durable memory/history lookup tool.",
  ].join("\n"));
  expect(containsFinalToolImplementationLeak("completion_obligations: source_verified", [])).toBe(true);
  expect(containsFinalToolImplementationLeak([
    "Since it answers both, the review concludes that this is complete.",
    "I will return only the final user-facing answer.",
    "",
    "Final Answer:",
    "현재 브랜치는 main입니다.",
  ].join("\n"), [])).toBe(true);
  expect(stripToolImplementationLeakLines([
    "Since it answers both, the review concludes that this is complete.",
    "I will return only the final user-facing answer.",
    "",
    "Final Answer:",
    "현재 브랜치는 main입니다.",
  ].join("\n"), [])).toBe("현재 브랜치는 main입니다.");
  expect(stripLeadingPublicWorkDecisionBlock([
    "summary: 공개 정보를 검색합니다.",
    "rationale: 최신 근거가 필요합니다.",
    "next_step: 검색 결과를 확인합니다.",
  ].join("\n"))).toBe("");
  expect(containsFinalPublicWorkDecisionLeak([
    "summary: 테스트 식당의 인기 메뉴와 냉면 외 특색 있는 메뉴를 조사하겠다냐!",
    "rationale: 테스트 사용자님이 궁금해하시는 가장 맛있다는 메뉴와 별미가 있는지 정확하게 알아봐야 하기 때문이다냐.",
    "",
    "냥, 맛있는 걸 찾는 건 네코마타도 아주 좋아하는 일이다냐~ 잠시만 기다려달라냐!",
  ].join("\n"))).toBe(true);
});

test("native runtime reviews public work decision finals even before tool evidence exists", async () => {
  const attempts: string[] = [];
  const executedTools: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      if (call.name === "web_search") {
        return {
          results: [{ title: "테스트 식당 메뉴", url: "https://example.test/hamgyeongok" }],
          source_urls: ["https://example.test/hamgyeongok"],
        };
      }
      return { ok: true };
    },
    runFunctionToolPromptText: async (input) => {
      attempts.push(input.prompt);
      if (attempts.length === 1) {
        return [
          "summary: 테스트 식당의 인기 메뉴를 검색합니다.",
          "rationale: 사용자가 현재 공개 정보를 물었습니다.",
          "",
          "잠시만 기다려 주세요.",
        ].join("\n");
      }
      expect(input.prompt).toContain("Goal Completion Review");
      await input.executeTool({
        name: "web_search",
        args: { query: "테스트 식당 사과냉면만두 추천 메뉴" },
        rawArguments: "{\"query\":\"테스트 식당 사과냉면만두 추천 메뉴\"}",
      });
      return "테스트 식당은 사과냉면과 만두가 함께 반복 언급됩니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/public-decision-before-tools",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "local/gemma-4",
    input: { text: "테스트 식당은 어떤 메뉴가 제일 맛있대?" },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(attempts).toHaveLength(2);
  expect(executedTools).toEqual(["web_search"]);
  expect(result.text).toContain("사과냉면");
  expect(result.text).not.toMatch(/^\s*작업\s*[:：]/u);
});

test("native runtime uses generic completion review to continue model-selected missing deliverables", async () => {
  const attempts: string[] = [];
  const executedTools: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      if (call.name === "web_search") {
        return {
          results: [{ title: "인구 통계", url: "https://example.test/population" }],
          source_urls: ["https://example.test/population"],
        };
      }
      if (call.name === "web_read") {
        return {
          source_url: "https://example.test/population",
          title: "인구 통계",
          text: "서울특별시 9,300,000명, 부산광역시 3,300,000명, 인천광역시 3,000,000명",
        };
      }
      if (call.name === "transform_public_data_table") {
        return {
          ok: true,
          artifact_label: "population.csv",
          artifact_path: "/tmp/population.csv",
          csv_preview: "city,population\n서울특별시,9300000",
        };
      }
      return { ok: true };
    },
    runFunctionToolPromptText: async (input) => {
      attempts.push(input.prompt);
      if (attempts.length === 1) {
        await input.onAssistantTextBeforeTools?.({
          text: "summary: 공개 인구 자료를 찾습니다.\nrationale: 산출물의 근거가 필요합니다.\nnext_step: 읽을 출처를 고릅니다.",
          toolCalls: [{ name: "web_search", args: { query: "한국 주요 도시 인구" } }],
        });
        await input.executeTool({
          name: "web_search",
          args: { query: "한국 주요 도시 인구" },
          rawArguments: JSON.stringify({ query: "한국 주요 도시 인구" }),
        });
        await input.onAssistantTextBeforeTools?.({
          text: "summary: 공개 출처 내용을 확인합니다.\nrationale: 파일 산출물의 행 값을 확정해야 합니다.\nnext_step: 확인한 행을 산출물로 정리합니다.",
          toolCalls: [{ name: "web_read", args: { url: "https://example.test/population" } }],
        });
        await input.executeTool({
          name: "web_read",
          args: { url: "https://example.test/population" },
          rawArguments: JSON.stringify({ url: "https://example.test/population" }),
        });
        return "근거는 확인했지만 CSV 파일 산출물은 아직 만들지 않았습니다.";
      }
      expect(input.prompt).toContain("Goal Completion Review");
      expect(input.prompt).toContain("Do not apply hardcoded rules for any specific tool");
      expect(input.prompt).toContain("This review is an action gate");
      expect(input.prompt).toContain("Attached native tool schemas are the source of truth");
      expect(input.prompt).toContain("reuse public facts, values, URLs, labels, artifact references");
      expect(input.prompt).toContain("Discovery/search evidence identifies candidates");
      expect(input.prompt).toContain("Durable deliverables require durable evidence");
      expect(input.prompt).not.toContain("transform_public_data_table");
      await input.onAssistantTextBeforeTools?.({
        text: "summary: 확인한 행을 파일 산출물로 정제합니다.\nrationale: 사용자가 결과와 별도 산출물을 함께 요청했습니다.\nnext_step: 산출물 기준으로 결과만 보고합니다.",
        toolCalls: [{ name: "transform_public_data_table", args: { columns: ["city", "population"], rows: [{ city: "서울특별시", population: 9300000 }] } }],
      });
      await input.executeTool({
        name: "transform_public_data_table",
        args: { columns: ["city", "population"], rows: [{ city: "서울특별시", population: 9300000 }] },
        rawArguments: JSON.stringify({ columns: ["city", "population"], rows: [{ city: "서울특별시", population: 9300000 }] }),
      });
      return "CSV 파일 산출물 population.csv를 만들고 결과를 요약했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      text: "공개 출처를 확인해 한국 주요 도시 3곳 인구 데이터를 CSV 파일 산출물로 정제하고 결과를 요약해 주세요.",
    },
  });

  expect(attempts).toHaveLength(2);
  expect(executedTools).toEqual(["web_search", "web_read", "transform_public_data_table"]);
  expect(result.text).toContain("CSV 파일 산출물");
});

test("goal completion review verdict without new tool evidence is not delivered as final answer", async () => {
  const attempts: string[] = [];
  const executedTools: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      return {
        ok: true,
        exit_code: 0,
        stdout_preview: "riposte source and notes inspected",
      };
    },
    runFunctionToolPromptText: async (input) => {
      attempts.push(input.prompt);
      if (attempts.length === 1) {
        await input.onAssistantTextBeforeTools?.({
          text: "summary: Riposte 제작 기록을 확인합니다.\nrationale: 사용자가 제작 과정을 소개할 글의 근거가 필요합니다.\nnext_step: 확인한 내용을 바탕으로 초안을 작성합니다.",
          toolCalls: [{ name: "run_command", args: { command: "pwd && ls" } }],
        });
        await input.executeTool({
          name: "run_command",
          args: { command: "pwd && ls" },
          rawArguments: JSON.stringify({ command: "pwd && ls" }),
        });
        return [
          "Riposte 소개 초안입니다.",
          "",
          "Riposte는 뱀서류 진행감에 패링 액션을 섞은 작은 AI 게임 대회 출품작입니다.",
          "초안에서 단순한 뱀서라이크로 시작했지만, 공격 타이밍에 맞춰 돌진하는 패링 규칙이 중심 재미가 됐습니다.",
        ].join("\n");
      }
      expect(input.prompt).toContain("Goal Completion Review");
      return [
        "순찰 완료다냐. 이전 답변은 테스트 사용자님의 원래 요청을 충족한 최종 답변으로 봐도 된다냐.",
        "",
        "따라서 지금 기준으로는 추가 도구 호출 없이, 이전 답변을 바탕으로 글을 다듬어가면 된다냐.",
      ].join("\n");
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/review-verdict-boundary",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/gpt-5.5",
    input: { text: "Riposte 제작 과정을 소개할 글 초안을 정리해줘." },
  });

  expect(attempts).toHaveLength(2);
  expect(executedTools).toContain("run_command");
  expect(result.text).toContain("Riposte 소개 초안");
  expect(result.text).toContain("패링 액션");
  expect(result.text).not.toContain("이전 답변");
  expect(result.text).not.toContain("추가 도구 호출 없이");
});

test("native runtime continues direct work when completion review returns incomplete", async () => {
  const attempts: string[] = [];
  const executedCommands: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      if (call.name === "run_command") {
        executedCommands.push(String(call.args.command));
        return {
          ok: true,
          command: call.args.command,
          cwd: tempDir,
          exit_code: 0,
          timed_out: false,
          stdout_preview: `ok: ${call.args.command}`,
        };
      }
      return { ok: true };
    },
    runFunctionToolPromptText: async (input) => {
      attempts.push(input.prompt);
      if (attempts.length === 1) {
        await input.onAssistantTextBeforeTools?.({
          text: "summary: 현재 커밋 상태를 확인합니다.\nrationale: 사용자 요청은 작업 단위 커밋을 요구했습니다.\nnext_step: 검증을 실행한 뒤 결과를 커밋합니다.",
          toolCalls: [{ name: "run_command", args: { command: "git status --short" } }],
        });
        await input.executeTool({
          name: "run_command",
          args: { command: "git status --short" },
          rawArguments: JSON.stringify({ command: "git status --short" }),
        });
        return "첫 커밋 상태는 확인했지만 검증과 다음 커밋은 아직 끝나지 않았습니다.";
      }
      if (input.prompt.includes("Goal Completion Incomplete Continuation")) {
        expect(input.prompt).toContain("검증과 다음 커밋은 아직 완료되지 않았습니다");
        await input.onAssistantTextBeforeTools?.({
          text: "summary: 요청된 검증과 커밋을 완료합니다.\nrationale: 리뷰 게이트가 아직 미완료라고 판단했습니다.\nnext_step: 검증 결과와 커밋 해시를 보고합니다.",
          toolCalls: [{ name: "run_command", args: { command: "bun test tests/e2e/direct-work.test.ts && git commit --allow-empty -m continuation" } }],
        });
        await input.executeTool({
          name: "run_command",
          args: { command: "bun test tests/e2e/direct-work.test.ts && git commit --allow-empty -m continuation" },
          rawArguments: JSON.stringify({
            command: "bun test tests/e2e/direct-work.test.ts && git commit --allow-empty -m continuation",
          }),
        });
        return "검증과 다음 커밋을 완료했습니다.";
      }
      expect(input.prompt).toContain("Goal Completion Review");
      if (!attempts.some((prompt) => prompt.includes("Goal Completion Incomplete Continuation"))) {
        return "INCOMPLETE: 검증과 다음 커밋은 아직 완료되지 않았습니다.";
      }
      return "검증과 다음 커밋을 완료했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/incomplete-continuation",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      text: "작업목록을 순서대로 직접 처리하고, 각 작업이 끝날 때마다 검증 후 커밋해줘.",
    },
  });

  expect(attempts.some((prompt) => prompt.includes("Goal Completion Incomplete Continuation")))
    .toBe(true);
  expect(executedCommands).toEqual([
    "git status --short",
    "bun test tests/e2e/direct-work.test.ts && git commit --allow-empty -m continuation",
  ]);
  expect(result.text).toContain("검증과 다음 커밋을 완료");
});

test("native runtime does not rerun completion review after planned public report is written", async () => {
  const attempts: string[] = [];
  const executedTools: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      if (call.name === "write_planned_public_report") {
        return {
          ok: true,
          task_id: "planned-public-report",
          status: "PUBLIC_REPORT_READY",
          report: "검토된 공개 보고입니다.",
        };
      }
      return { ok: true };
    },
    runFunctionToolPromptText: async (input) => {
      attempts.push(input.prompt);
      if (attempts.length > 1) {
        throw new Error("completion review should not run after a planned public report");
      }
      await input.executeTool({
        name: "write_planned_public_report",
        args: {
          task_id: "planned-public-report",
          report: "검토된 공개 보고입니다.",
        },
        rawArguments: JSON.stringify({
          task_id: "planned-public-report",
          report: "검토된 공개 보고입니다.",
        }),
      });
      return "검토된 공개 보고입니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/app-planned-public-report",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/gpt-5.5",
    input: { text: "완료된 계획 작업을 공개 보고해줘." },
  });

  expect(attempts).toHaveLength(1);
  expect(executedTools).toEqual(["write_planned_public_report"]);
  expect(result.text).toBe("검토된 공개 보고입니다.");
});

test("planned review turns block sibling planned task creation", async () => {
  const executedTools: string[] = [];
  let blockedOutput: unknown = null;
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      return { ok: true };
    },
    runFunctionToolPromptText: async (input) => {
      blockedOutput = await input.executeTool({
        name: "create_planned_task",
        args: {
          goal: "같은 목표를 새 계획으로 다시 실행한다.",
          acceptance_criteria: ["새 sibling plan이 생기면 안 된다."],
        },
        rawArguments: JSON.stringify({
          goal: "같은 목표를 새 계획으로 다시 실행한다.",
          acceptance_criteria: ["새 sibling plan이 생기면 안 된다."],
        }),
      });
      return "blocked";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/app-planned-review-sibling-block",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/gpt-5.5",
    input: {
      eventId: "system:planned-review:planned-parent:1779517998479",
      accountId: "default",
      transport: "system",
      peer: { kind: "dm", id: "butler/app-planned-review-sibling-block" },
      sender: { id: "butler-worker-monitor" },
      message: {
        id: "planned-review:planned-parent",
        text: "System event: a planned background worker attempt completed.\n\nPlanned task ID: planned-parent\nStatus: WORKER_DONE",
        timestamp: new Date().toISOString(),
      },
    },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(executedTools).toEqual([]);
  expect(blockedOutput).toMatchObject({
    ok: false,
    blocked_tool: "create_planned_task",
    planned_review_task_id: "planned-parent",
  });
});

test("planned review turns stop after starting a repair attempt", async () => {
  const attempts: string[] = [];
  const executedTools: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      if (call.name === "review_planned_task") {
        return {
          ok: true,
          task_id: "planned-parent",
          attempt: 1,
          verdict: "FAIL",
          status: "REVIEW_FAILED",
        };
      }
      if (call.name === "repair_planned_task") {
        return {
          ok: true,
          task_id: "planned-parent",
          worker_task_id: "worker-repair",
          attempt: 2,
          status: "PLANNED_RUNNING",
        };
      }
      throw new Error(`unexpected tool ${call.name}`);
    },
    runFunctionToolPromptText: async (input) => {
      attempts.push(input.prompt);
      await input.executeTool({
        name: "review_planned_task",
        args: {
          task_id: "planned-parent",
          attempt: 1,
          criteria: [{
            criterion: "필수 구현이 끝나야 한다.",
            verdict: "FAIL",
            evidence: "worker가 구현을 완료하지 못했다.",
          }],
          goal_review: {
            verdict: "FAIL",
            evidence: "내부 목표가 완료되지 않았다.",
          },
        },
        rawArguments: JSON.stringify({ task_id: "planned-parent" }),
      });
      const repairOutput = await input.executeTool({
        name: "repair_planned_task",
        args: {
          task_id: "planned-parent",
          repair_objective: "원래 목표 안에서 누락된 구현을 완료한다.",
        },
        rawArguments: JSON.stringify({ task_id: "planned-parent" }),
      });
      const finalText = await input.finalTextFromToolResult?.({
        name: "repair_planned_task",
        args: { task_id: "planned-parent" },
        output: repairOutput,
      });
      if (finalText) return finalText;
      await input.executeTool({
        name: "create_planned_task",
        args: {
          goal: "같은 목표를 새 계획으로 다시 실행한다.",
          acceptance_criteria: ["새 sibling plan이 생기면 안 된다."],
        },
        rawArguments: JSON.stringify({ goal: "같은 목표를 새 계획으로 다시 실행한다." }),
      });
      return "continued incorrectly";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/app-planned-review-repair-terminal",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/gpt-5.5",
    input: {
      eventId: "system:planned-review:planned-parent:1779517998479",
      accountId: "default",
      transport: "system",
      peer: { kind: "dm", id: "butler/app-planned-review-repair-terminal" },
      sender: { id: "butler-worker-monitor" },
      message: {
        id: "planned-review:planned-parent",
        text: "System event: a planned background worker attempt completed.\n\nPlanned task ID: planned-parent\nStatus: WORKER_DONE",
        timestamp: new Date().toISOString(),
      },
    },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(attempts).toHaveLength(1);
  expect(executedTools).toEqual(["review_planned_task", "repair_planned_task"]);
  expect(result.text).toContain("수리 작업을 시작했습니다");
});

test("planned review turns inject event ownership into scoped review tools", async () => {
  const observedArgs: Array<Record<string, unknown>> = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      observedArgs.push(call.args);
      return {
        ok: true,
        task_id: "planned-parent",
        attempt: 2,
        verdict: "PASS",
        status: "REVIEW_PASSED",
      };
    },
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "review_planned_task",
        args: {
          criteria: [{
            criterion: "검토 기준",
            verdict: "PASS",
            evidence: "확인했다.",
          }],
          goal_review: {
            verdict: "PASS",
            evidence: "목표가 완료되었다.",
          },
        },
        rawArguments: JSON.stringify({ criteria: [] }),
      });
      return "검토가 끝났습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/app-planned-review-event-owned",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/gpt-5.5",
    input: {
      eventId: "system:planned-review:planned-parent:attempt-2:review-planned-parent-worker-review-2",
      accountId: "default",
      transport: "system",
      peer: { kind: "dm", id: "butler/app-planned-review-event-owned" },
      sender: { id: "butler-worker-monitor" },
      message: {
        id: "planned-review:planned-parent",
        text: [
          "System event: a planned background worker attempt completed.",
          "",
          "Planned task ID: planned-parent",
          "Attempt: 2",
          "Worker task ID: worker-review",
          "Review event ID: review-planned-parent-worker-review-2",
          "Status: WORKER_DONE",
        ].join("\n"),
        timestamp: new Date().toISOString(),
      },
    },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(observedArgs[0]).toMatchObject({
    task_id: "planned-parent",
    attempt: 2,
    worker_task_id: "worker-review",
    review_event_id: "review-planned-parent-worker-review-2",
  });
});

test("completion review retries when one search is inconclusive", async () => {
  const attempts: string[] = [];
  const executedTools: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      return {
        results: call.args.query === "site:go.kr 2025 주요 도시 인구"
          ? [{ title: "공개 통계", url: "https://example.test/population-2025" }]
          : [],
        source_urls: call.args.query === "site:go.kr 2025 주요 도시 인구"
          ? ["https://example.test/population-2025"]
          : [],
      };
    },
    runFunctionToolPromptText: async (input) => {
      attempts.push(input.prompt);
      if (attempts.length === 1) {
        await input.onAssistantTextBeforeTools?.({
          text: "summary: 2025년 도시 인구 후보를 먼저 검색합니다.\nrationale: 공개 근거가 필요합니다.\nnext_step: 충분한 후보가 없으면 검색 범위를 조정합니다.",
          toolCalls: [{ name: "web_search", args: { query: "2025 주요 도시 인구" } }],
        });
        await input.executeTool({
          name: "web_search",
          args: { query: "2025 주요 도시 인구" },
          rawArguments: JSON.stringify({ query: "2025 주요 도시 인구" }),
        });
        return "검색 결과가 부족해서 확인할 수 없습니다.";
      }
      expect(input.prompt).toContain("Goal Completion Review");
      expect(input.prompt).toContain("single inconclusive or low-evidence search");
      await input.onAssistantTextBeforeTools?.({
        text: "summary: 더 권위 있는 출처 중심으로 검색을 넓힙니다.\nrationale: 첫 검색만으로 실패를 확정할 수 없습니다.\nnext_step: 확보한 후보를 결과 근거로 사용합니다.",
        toolCalls: [{ name: "web_search", args: { query: "site:go.kr 2025 주요 도시 인구" } }],
      });
      await input.executeTool({
        name: "web_search",
        args: { query: "site:go.kr 2025 주요 도시 인구" },
        rawArguments: JSON.stringify({ query: "site:go.kr 2025 주요 도시 인구" }),
      });
      return "다시 검색해 2025년 공개 통계 후보를 확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/search-retry",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "local/gemma-4",
    input: { text: "2025년 기준 주요 도시 인구 자료를 찾아줘" },
  });

  expect(executedTools).toEqual(["web_search", "web_search"]);
  expect(result.text).toContain("다시 검색");
});

test("completion review pushes chart requests toward executable artifacts", async () => {
  const attempts: string[] = [];
  const executedTools: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      if (call.name === "web_read") {
        return {
          source_url: "https://example.test/population",
          title: "인구 통계",
          text: "서울 9300000 부산 3300000 인천 3000000",
          evidence_capability_receipts: [capabilityReceipt({
            id: "ecr-chart-web-read-source",
            producerName: "web_read",
            capability: "source_verified",
            evidenceKind: "source_page",
            satisfies: ["source_verified"],
            reference: { url: "https://example.test/population" },
          })],
        };
      }
      if (call.name === "run_command") {
        return {
          ok: true,
          exit_code: 0,
          artifact_label: "population-chart.png",
          stdout_preview: "wrote population-chart.png",
          evidence_capability_receipts: [capabilityReceipt({
            id: "ecr-chart-command",
            producerName: "run_command",
            capability: "command_executed",
            evidenceKind: "execution_result",
            satisfies: ["command_executed"],
          })],
        };
      }
      return { ok: true };
    },
    runFunctionToolPromptText: async (input) => {
      attempts.push(input.prompt);
      if (attempts.length === 1) {
        await input.onAssistantTextBeforeTools?.({
          text: "summary: 차트에 넣을 공개 자료 본문을 확인합니다.\nrationale: 그래프의 값이 근거를 가져야 합니다.\nnext_step: 확인한 값으로 차트를 생성합니다.\ncompletion_obligations: source_verified, command_executed",
          toolCalls: [{ name: "web_read", args: { url: "https://example.test/population" } }],
        });
        await input.executeTool({
          name: "web_read",
          args: { url: "https://example.test/population" },
          rawArguments: JSON.stringify({ url: "https://example.test/population" }),
        });
        return "아래 matplotlib 코드를 복사해서 실행하면 됩니다.\n```python\nprint('chart')\n```";
      }
      expect(input.prompt).toContain("Goal Completion Review");
      expect(input.prompt).toContain("Generated charts, data files, and executable-code outcomes require execution");
      expect(input.prompt).toContain("text, or response environment prevents creating files");
      expect(input.prompt).toContain("next: 확인한 값으로 차트를 생성합니다.");
      expect(input.prompt).toContain("completion_obligations: source_verified, command_executed");
      await input.onAssistantTextBeforeTools?.({
        text: "summary: 확인한 데이터로 차트 파일을 직접 생성합니다.\nrationale: 사용자는 실행된 결과를 원했고 코드만으로는 완료가 아닙니다.\nnext_step: 생성된 파일 기준으로 결과만 보고합니다.\ncompletion_obligations: command_executed",
        toolCalls: [{ name: "run_command", args: { command: "python3 scripts/render_chart.py" } }],
      });
      await input.executeTool({
        name: "run_command",
        args: { command: "python3 scripts/render_chart.py" },
        rawArguments: JSON.stringify({ command: "python3 scripts/render_chart.py" }),
      });
      return "차트 파일 population-chart.png를 생성했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/chart-exec",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "local/gemma-4",
    input: { text: "2025년 도시 인구 데이터로 matplotlib 차트를 그려줘" },
  });

  expect(executedTools).toEqual(["web_read", "run_command"]);
  expect(result.text).toContain("population-chart.png");
});

test("goal completion review carries public decision next steps for durable artifact closure", () => {
  const prompt = goalCompletionReviewPrompt({
    prompt: "공개 자료를 확인하고 CSV와 matplotlib 차트를 만들어 보고해 주세요.",
    previousAnswer: "CSV는 본문에 적었고, 차트는 텍스트 환경이라 직접 제공하지 못합니다.",
    audit: [{
      name: "web_read",
      args: { url: "https://example.test/population" },
      ok: true,
      result: {
        source_url: "https://example.test/population",
        title: "인구 통계",
      },
      publicDecision: {
        decisionId: "decision-1",
        summary: "공개 출처 본문을 확인합니다.",
        rationale: "수치가 검색 후보가 아니라 실제 본문 근거를 가져야 합니다.",
        nextStep: "확인한 수치로 CSV 파일과 차트 이미지를 생성합니다.",
        completionObligations: ["source_verified", "command_executed"],
        evidenceRefs: [],
        source: "assistant-authored",
      },
    }],
    decisions: [{
      decisionId: "decision-1",
      summary: "공개 출처 본문을 확인합니다.",
      rationale: "수치가 검색 후보가 아니라 실제 본문 근거를 가져야 합니다.",
      nextStep: "확인한 수치로 CSV 파일과 차트 이미지를 생성합니다.",
      completionObligations: ["source_verified", "command_executed"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  });

  expect(prompt).toContain("Recent public work decisions, including pending next steps");
  expect(prompt).toContain("why: 수치가 검색 후보가 아니라 실제 본문 근거를 가져야 합니다.");
  expect(prompt).toContain("next: 확인한 수치로 CSV 파일과 차트 이미지를 생성합니다.");
  expect(prompt).toContain("completion_obligations: source_verified, command_executed");
  expect(prompt).toContain("Do not claim that the chat, text, or response environment prevents creating files");
  expect(prompt).toContain("Review each recent public work decision's `completion_obligations`");
  expect(prompt).toContain("do not treat an empty result from one exact case-sensitive text search as proof of absence");
  expect(prompt).toContain("Preserve the active persona");
});

test("native tool loop prompt requires semantic progress first and output path artifact evidence", async () => {
  let instructions = "";
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    runFunctionToolPromptText: async (input) => {
      instructions = input.instructions ?? "";
      return "진행하겠습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/tool-prompt-contract",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "공개 자료를 수집하고 CSV와 차트를 만들어 보고해줘." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(instructions).toContain("make the first tool call `update_todo_list`");
  expect(instructions).toContain("three to six semantic goal steps");
  expect(instructions).toContain("two or more independent checks");
  expect(instructions).toContain("combines local inspection with a final synthesis/report");
  expect(instructions).toContain("start with `update_todo_list` even if the work can finish in the same turn");
  expect(instructions).toContain("checking the current branch plus package scripts");
  expect(instructions).toContain("Set each todo item's `phase`");
  expect(instructions).toContain("`conception`, `planning`, `execution`, `review`, `consolidation`, or `reporting`");
  expect(instructions).toContain("Butler-owned durable WorkStream");
  expect(instructions).toContain("Project sessions and future super sessions are both user-facing Butler sessions");
  expect(instructions).toContain("Use `list_work_streams` when context switching across concurrent issues");
  expect(instructions).toContain("## Persona Continuity");
  expect(instructions).toContain("Use the configured Assistant Response Language from the Turn Environment");
  expect(instructions).toContain("Preserve the persona's tone and signature speech patterns in every situation");
  expect(instructions).not.toContain("safety/accuracy requires a calmer voice");
  expect(instructions).toContain("Do not let native tool, review, or report formatting instructions erase the persona.");
  expect(instructions).toContain("include `output_paths`");
  expect(instructions).toContain("structured artifact evidence");
  expect(instructions).toContain(
    "Use `durable_artifact` only when the immediate tool path will create, update, write, render, or attach a durable deliverable",
  );
  expect(instructions).toContain(
    "Do not use `durable_artifact` for merely reading, listing, checking, or confirming existing Project Ledger/workspace documents",
  );
  expect(instructions).toContain("Do not add `completion_obligations` for preference, style, feedback");
});

test("public work decision parser carries completion obligations without displaying them as summaries", () => {
  const [decision] = publicWorkDecisionsFromAssistantText({
    text: [
      "summary: 차트에 넣을 공개 자료 본문을 확인합니다.",
      "rationale: 값이 실제 본문 근거를 가져야 합니다.",
      "next_step: 확인한 값으로 로컬 실행 단계를 이어갑니다.",
      "completion_obligations: source_verified, command_executed, chart_rendered",
    ].join("\n"),
    toolCalls: [{ name: "web_read", args: { url: "https://example.test/population" } }],
    language: "ko",
    existingDecisions: [],
  });

  expect(decision).toBeDefined();
  expect(decision!.summary).toBe("차트에 넣을 공개 자료 본문을 확인합니다.");
  expect(decision!.completionObligations).toEqual([
    "source_verified",
    "command_executed",
    "chart_rendered",
  ]);
});

test("public work decision parser ignores non-canonical prose before tool calls", () => {
  const pending = publicWorkDecisionsFromAssistantText({
    text: "Je vais verifier la source publique avant de continuer. 次に公開情報を確認します。",
    toolCalls: [{ name: "web_read", args: { url: "https://example.test/population" } }],
    language: "ko",
    existingDecisions: [],
  });

  expect(pending).toEqual([]);

  const fallback = takePublicWorkDecisionForTool({
    pending,
    toolName: "web_read",
    language: "ko",
    previousDecisions: [],
    progress: {
      kind: "read",
      toolName: "Web read",
      safeLabel: "Reading public source: example.test",
      workBlockLabel: "선택한 출처의 내용을 확인합니다.",
      inputLabel: "example.test",
      detailRows: [],
    },
  });

  expect(fallback.source).toBe("runtime-derived");
  expect(fallback.summary).toBe("선택한 출처의 내용을 확인합니다.");
});

test("completion obligation guard detects unsatisfied command execution", () => {
  const reason = completionObligationIncompleteReason({
    audit: [{
      name: "web_read",
      args: { url: "https://example.test/population" },
      ok: true,
      result: {
        source_url: "https://example.test/population",
        evidence_capability_receipts: [capabilityReceipt({
          id: "ecr-web-read-source",
          producerName: "web_read",
          capability: "source_verified",
          evidenceKind: "source_page",
          satisfies: ["source_verified"],
          reference: { url: "https://example.test/population" },
        })],
      },
    }],
    decisions: [{
      decisionId: "decision-1",
      summary: "공개 출처 본문을 확인합니다.",
      rationale: "값을 확인한 뒤 실행 도구로 차트를 만들기 위해서입니다.",
      nextStep: "확인한 값으로 차트를 생성합니다.",
      completionObligations: ["source_verified", "command_executed"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  });

  expect(reason).toContain("command_executed");
  expect(completionObligationIncompleteReason({
    audit: [{
      name: "run_command",
      args: { command: "python3 chart.py" },
      ok: true,
      result: {
        ok: true,
        exit_code: 0,
        evidence_capability_receipts: [capabilityReceipt({
          id: "ecr-command-executed",
          producerName: "run_command",
          capability: "command_executed",
          evidenceKind: "execution_result",
          satisfies: ["command_executed"],
        })],
      },
    }],
    decisions: [{
      decisionId: "decision-1",
      summary: "확인한 값으로 차트를 생성합니다.",
      completionObligations: ["command_executed"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  })).toBeNull();
});

test("completion obligation guard accepts durable worker status inspection as source evidence", () => {
  expect(completionObligationIncompleteReason({
    audit: [{
      name: "get_work_dashboard",
      args: { limit: 10 },
      ok: true,
      result: {
        ok: true,
        counts: { running: 0, failed: 1 },
        failed: [{
          task_id: "task-worker-1",
          status: "FAILED",
          activity_status_line: "Failed: worker result needs review.",
        }],
        evidence_capability_receipts: [capabilityReceipt({
          id: "ecr-work-dashboard-source",
          producerName: "get_work_dashboard",
          capability: "source_verified",
          evidenceKind: "project_state",
          satisfies: ["source_verified"],
          reference: { task_id: "task-worker-1" },
        })],
      },
    }],
    decisions: [{
      decisionId: "decision-worker-status",
      summary: "워커 상태를 durable dashboard에서 확인합니다.",
      completionObligations: ["source_verified"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  })).toBeNull();

  expect(completionObligationIncompleteReason({
    audit: [{
      name: "get_task_result",
      args: { task_id: "missing-worker" },
      ok: true,
      result: {
        ok: false,
        task_id: "missing-worker",
        error: "task not found",
        evidence_capability_receipts: [capabilityReceipt({
          id: "ecr-task-result-source",
          producerName: "get_task_result",
          capability: "source_verified",
          evidenceKind: "project_state",
          satisfies: ["source_verified"],
          reference: { task_id: "missing-worker" },
        })],
      },
    }],
    decisions: [{
      decisionId: "decision-missing-worker-status",
      summary: "요청한 워커가 있는지 durable task store에서 확인합니다.",
      completionObligations: ["source_verified"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  })).toBeNull();
});

test("completion obligation guard accepts structured source evidence contracts", () => {
  const capabilityEvidence = satisfiedCompletionObligationsForToolResult("list_tool_capabilities", {
    ok: true,
    capabilities: [{ name: "run_command" }],
  });
  expect(capabilityEvidence).toEqual([]);
  expect(satisfiedCompletionObligationsForToolResult("create_automation", { ok: true })).not.toContain(
    "source_verified",
  );
  expect(satisfiedCompletionObligationsForToolResult("create_automation", {
    ok: true,
    evidence_receipts: [{
      schema: "butler.evidence-receipt.v1",
      id: "receipt-state-source",
      producer: { kind: "tool", name: "create_automation" },
      receiptType: "state",
      verified: true,
      covers: ["state_inspection"],
      summary: "A stateful tool result was verified by its own receipt.",
      references: [{ kind: "task", ref: "automation:auto_1" }],
      satisfies: ["source_verified"],
    }],
  })).toContain("source_verified");

  expect(completionObligationIncompleteReason({
    audit: [{
      name: "list_tool_capabilities",
      args: { include_disabled: true },
      ok: true,
      result: {
        ok: true,
        capabilities: [{ name: "run_command" }],
        evidence_capability_receipts: [{
          receipt_id: "ecr-tool-catalog-source",
          schema_version: "evidence-capability.v1",
          producer: { kind: "tool", name: "list_tool_capabilities" },
          capability: "source_verified",
          evidence_kind: "project_state",
          maturity: "verified",
          confidence: 0.9,
          verified: true,
          summary: "The native tool catalog was inspected.",
          references: [{ task_id: "tool-catalog" }],
          satisfies: ["source_verified"],
          limitations: [],
          created_at: "2026-06-22T08:07:00.000Z",
        }],
      },
    }],
    decisions: [{
      decisionId: "decision-tool-catalog",
      summary: "현재 노출된 네이티브 툴 카탈로그를 확인합니다.",
      completionObligations: ["source_verified"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  })).toBeNull();

  const unsupportedActionReason = completionObligationIncompleteReason({
    audit: [{
      name: "create_automation",
      args: { prompt: "ping" },
      ok: true,
      result: { ok: true, id: "auto_1" },
    }],
    decisions: [{
      decisionId: "decision-action-only",
      summary: "자동화를 생성합니다.",
      completionObligations: ["source_verified"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  });
  expect(unsupportedActionReason).toContain("source_verified");
});

test("completion obligation guard treats capability receipts as authoritative over tool names", () => {
  const candidateOnly = createEvidenceCapabilityReceipt({
    producer: { kind: "tool", name: "web_read" },
    capability: "source_candidate",
    evidence_kind: "source_candidate",
    maturity: "candidate",
    verified: false,
    confidence: 0.4,
    summary: "A source candidate was discovered but not verified.",
    references: [{ url: "https://example.test/population" }],
    limitations: ["Source page was not read."],
    created_at: "2026-06-22T08:03:00.000Z",
  });

  expect(satisfiedCompletionObligationsForToolResult("list_tool_capabilities", {
    ok: true,
    capabilities: [{ name: "run_command" }],
    evidence_capability_receipts: [candidateOnly],
  })).toEqual([]);

  const reason = completionObligationIncompleteReason({
    audit: [{
      name: "web_read",
      args: { url: "https://example.test/population" },
      ok: true,
      result: {
        ok: true,
        source_url: "https://example.test/population",
        evidence_capability_receipts: [candidateOnly],
      },
    }],
    decisions: [{
      decisionId: "decision-capability-authority",
      summary: "공개 출처 본문을 확인합니다.",
      completionObligations: ["source_verified"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  });

  expect(reason).toBe("The turn still needs repair for missing public completion obligation(s): source_verified.");

  const verifiedProjectState = createEvidenceCapabilityReceipt({
    producer: { kind: "tool", name: "create_automation" },
    capability: "source_verified",
    evidence_kind: "project_state",
    verified: true,
    confidence: 0.9,
    summary: "Durable project state was inspected.",
    references: [{ task_id: "automation:auto_1" }],
    satisfies: ["source_verified"],
    created_at: "2026-06-22T08:04:00.000Z",
  });

  expect(completionObligationIncompleteReason({
    audit: [{
      name: "create_automation",
      args: { prompt: "ping" },
      ok: true,
      result: {
        ok: true,
        evidence_capability_receipts: [verifiedProjectState],
      },
    }],
    decisions: [{
      decisionId: "decision-capability-positive",
      summary: "자동화 상태를 확인합니다.",
      completionObligations: ["source_verified"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  })).toBeNull();
});

test("completion obligation guard returns explicit blocker outcome from capability receipts", () => {
  const blocker = createEvidenceCapabilityReceipt({
    producer: { kind: "runtime", name: "completion_guard" },
    capability: "explicit_blocker",
    evidence_kind: "blocker",
    maturity: "verified",
    verified: true,
    confidence: 1,
    summary: "Required source credential is unavailable.",
    limitations: ["A user-owned credential is required."],
    created_at: "2026-06-22T08:05:00.000Z",
  });

  expect(completionObligationIncompleteReason({
    audit: [{
      name: "web_read",
      args: { url: "https://example.test/private" },
      ok: true,
      result: {
        ok: true,
        evidence_capability_receipts: [blocker],
      },
    }],
    decisions: [{
      decisionId: "decision-explicit-blocker",
      summary: "비공개 출처를 확인합니다.",
      completionObligations: ["source_verified"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  })).toBe("The turn is blocked by unresolved public completion obligation(s): source_verified.");
});

test("completion obligation guard accepts Project Ledger state inspection as source evidence", () => {
  expect(completionObligationIncompleteReason({
    audit: [{
      name: "inspect_project_status",
      args: { project_path: "/tmp/sandy-bot" },
      ok: true,
      result: {
        ok: false,
        error: {
          code: "not_initialized",
          message: "Project Ledger not initialized at /tmp/sandy-bot",
        },
        evidence_capability_receipts: [capabilityReceipt({
          id: "ecr-project-status-source-missing",
          producerName: "inspect_project_status",
          capability: "source_verified",
          evidenceKind: "project_state",
          satisfies: ["source_verified"],
          reference: { task_id: "project-ledger-status" },
        })],
      },
    }],
    decisions: [{
      decisionId: "decision-project-ledger-status",
      summary: "Project Ledger 상태를 확인합니다.",
      completionObligations: ["source_verified"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  })).toBeNull();
});

test("native runtime skips completion review when capability evidence satisfies the outcome contract", async () => {
  const attempts: string[] = [];
  const executedTools: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      return {
        ok: true,
        project: { id: "butler" },
        counts: { work: 0 },
        evidence_capability_receipts: [{
          receipt_id: "ecr-project-status-source",
          schema_version: "evidence-capability.v1",
          producer: { kind: "tool", name: "inspect_project_status" },
          capability: "source_verified",
          evidence_kind: "project_state",
          maturity: "verified",
          confidence: 0.9,
          verified: true,
          summary: "Project Ledger state was inspected.",
          references: [{ task_id: "project-ledger-status" }],
          satisfies: ["source_verified"],
          limitations: [],
          created_at: "2026-06-22T08:08:00.000Z",
        }],
      };
    },
    runFunctionToolPromptText: async (input) => {
      attempts.push(input.prompt);
      if (attempts.length > 1) {
        throw new Error("completion review should be skipped when capability evidence satisfies obligations");
      }
      await input.onAssistantTextBeforeTools?.({
        text: [
          "summary: Project Ledger 상태를 확인합니다.",
          "rationale: 최종 보고가 추측이 아니라 durable 프로젝트 상태에 근거해야 합니다.",
          "next_step: 확인한 상태를 기준으로 요약합니다.",
          "completion_obligations: source_verified",
        ].join("\n"),
        toolCalls: [{ name: "inspect_project_status", args: {} }],
      });
      await input.executeTool({
        name: "inspect_project_status",
        args: {},
        rawArguments: "{}",
      });
      return "Project Ledger 상태를 확인했고, 해당 상태 기준으로 요약할 수 있습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/capability-evidence-skip",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      text: "Project Ledger 상태를 확인하고 요약해줘.",
    },
  });

  expect(executedTools).toEqual(["inspect_project_status"]);
  expect(attempts).toHaveLength(1);
  expect(result.text).toContain("Project Ledger 상태를 확인");
});

test("native runtime skips completion review when evidence receipts satisfy the outcome contract", async () => {
  const attempts: string[] = [];
  const executedTools: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      return {
        ok: true,
        source_url: "https://example.test/population",
        evidence_receipts: [{
          schema: "butler.evidence-receipt.v1",
          id: "receipt-read-source",
          producer: { kind: "tool", name: "web_read" },
          receiptType: "source",
          verified: true,
          covers: ["source_verified"],
          summary: "The requested public source page was read.",
          references: [{ kind: "url", ref: "https://example.test/population" }],
          satisfies: ["source_verified"],
        }],
      };
    },
    runFunctionToolPromptText: async (input) => {
      attempts.push(input.prompt);
      if (attempts.length > 1) {
        throw new Error("completion review should be skipped when verified receipts satisfy obligations");
      }
      await input.onAssistantTextBeforeTools?.({
        text: [
          "summary: 공개 출처 본문을 확인합니다.",
          "rationale: 답변의 근거를 실제 출처에 연결해야 합니다.",
          "next_step: 확인한 출처 기준으로 요약합니다.",
          "completion_obligations: source_verified",
        ].join("\n"),
        toolCalls: [{ name: "web_read", args: { url: "https://example.test/population" } }],
      });
      await input.executeTool({
        name: "web_read",
        args: { url: "https://example.test/population" },
        rawArguments: JSON.stringify({ url: "https://example.test/population" }),
      });
      return "공개 출처 본문을 확인했고, 해당 출처 기준으로 요약할 수 있습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/evidence-receipt-skip",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "공개 출처를 확인하고 요약해줘" },
  });

  expect(attempts).toHaveLength(1);
  expect(executedTools).toEqual(["web_read"]);
  expect(result.text).toContain("공개 출처 본문을 확인했고, 해당 출처 기준으로 요약할 수 있습니다.");
  expect(result.text).toContain("https://example.test/population");
});

test("tool result transcript projection keeps replayable evidence and drops private raw payloads", () => {
  const projection = evidenceTranscriptToolResultProjection({
    ok: true,
    raw_output: "raw payload strings SECRET_TOKEN raw prompt text <think>hidden</think> /Users/private/file",
    prompt: "raw prompt text",
    evidence_capability_receipts: [{
      receipt_id: "ecr-safe-source",
      schema_version: "evidence-capability.v1",
      producer: { kind: "tool", name: "web_read", call_id: "call-safe" },
      capability: "source_verified",
      evidence_kind: "source_page",
      maturity: "verified",
      confidence: 0.9,
      verified: true,
      summary: "Public source was read.",
      scope: {
        prompt: "raw prompt text",
        path: "/Users/private/project",
      },
      references: [{ url: "https://example.test/source", label: "Source page" }],
      satisfies: ["source_verified"],
      limitations: ["Only a bounded public excerpt was used."],
      created_at: "2026-06-22T08:08:00.000Z",
    }, {
      receipt_id: "ecr-validation",
      schema_version: "evidence-capability.v1",
      producer: { kind: "tool", name: "run_command" },
      capability: "validation_passed",
      evidence_kind: "execution_result",
      maturity: "verified",
      confidence: 0.95,
      verified: true,
      summary: "A validation suite completed successfully.",
      scope: {
        suite: "sandy-typecheck",
        result: "passed",
        path: "/Users/private/project",
      },
      references: [],
      limitations: [],
      created_at: "2026-06-22T08:09:00.000Z",
    }],
    evidence_receipts: [{
      schema: "butler.evidence-receipt.v1",
      id: "legacy-source",
      producer: { kind: "tool", name: "web_read" },
      receiptType: "source",
      verified: true,
      covers: ["source_verified"],
      summary: "Legacy public source receipt.",
      references: [{ kind: "url", ref: "https://example.test/source" }],
      artifacts: [{ id: "artifact-safe", path: "/Users/private/artifact.txt", label: "Saved artifact" }],
      satisfies: ["source_verified"],
    }],
  });

  expect(projection.schema_version).toBe("butler.tool-result-evidence-transcript.v1");
  expect(projection.evidence_capability_receipts).toHaveLength(3);
  expect(projection.evidence_capability_receipts).toContainEqual(expect.objectContaining({
    receipt_id: "ecr-safe-source",
    schema_version: "evidence-capability.v1",
    capability: "source_verified",
    satisfies: ["source_verified"],
  }));
  expect(projection.evidence_capability_receipts.find((receipt) =>
    receipt.receipt_id === "ecr-safe-source")).not.toHaveProperty("scope");
  expect(projection.evidence_capability_receipts.find((receipt) =>
    receipt.receipt_id === "ecr-validation")).toMatchObject({
      capability: "validation_passed",
      scope: {
        suite: "sandy-typecheck",
        result: "passed",
      },
    });
  expect(projection.evidence_receipts).toHaveLength(1);
  expect(projection.evidence_receipts[0].artifacts?.[0]).toEqual({
    id: "artifact-safe",
    label: "Saved artifact",
  });
  expect(projection.evidence_limitations).toEqual(["Only a bounded public excerpt was used."]);
  expect(projection.completion_obligation_evidence.limitations).toEqual(["Only a bounded public excerpt was used."]);

  const serialized = JSON.stringify(projection);
  expect(serialized).toContain("evidence-capability.v1");
  expect(serialized).toContain("butler.evidence-receipt.v1");
  expect(serialized).not.toContain("SECRET_TOKEN");
  expect(serialized).not.toContain("raw prompt text");
  expect(serialized).not.toContain("<think>");
  expect(serialized).not.toContain("/Users/private");
  expect(serialized).not.toContain("raw payload strings");
});

test("tool call transcript projection preserves safe arguments without raw private payloads", () => {
  const projection = evidenceTranscriptToolCallArgumentsProjection({
    command: "bun test tests/unit/native-tool-loop-runtime.test.ts",
    token: "abc123opaque",
    api_key: "sk_live_abc123",
    password: "hunter2",
    nested: {
      authorization: "abc.def.ghi",
      path: "/Users/private/project/.env",
      safe: "public label",
    },
  });

  expect(projection).toMatchObject({
    schema_version: "butler.tool-call-arguments-transcript.v1",
    argument_keys: ["command", "token", "api_key", "password", "nested"],
    safe_arguments: {
      command: "bun test tests/unit/native-tool-loop-runtime.test.ts",
      token: "[redacted]",
      api_key: "[redacted]",
      password: "[redacted]",
      nested: {
        authorization: "[redacted]",
        path: "[redacted]",
        safe: "public label",
      },
    },
  });
  const serialized = JSON.stringify(projection);
  expect(serialized).not.toContain("SECRET_TOKEN");
  expect(serialized).not.toContain("abc123opaque");
  expect(serialized).not.toContain("sk_live_abc123");
  expect(serialized).not.toContain("hunter2");
  expect(serialized).not.toContain("/Users/private");
  expect(serialized).not.toContain("abc.def.ghi");
});

test("native runtime stores privacy-safe replayable evidence receipts for tool results", async () => {
  let modelVisibleToolResult: unknown;
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async () => ({
      ok: true,
      raw_output: "raw payload strings SECRET_TOKEN raw prompt text <think>hidden</think> /Users/private/file",
      evidence_capability_receipts: [{
        receipt_id: "ecr-runtime-source",
        schema_version: "evidence-capability.v1",
        producer: { kind: "tool", name: "web_read" },
        capability: "source_verified",
        evidence_kind: "source_page",
        maturity: "verified",
        confidence: 0.9,
        verified: true,
        summary: "A public source page was read.",
        references: [{ url: "https://example.test/runtime-source" }],
        satisfies: ["source_verified"],
        limitations: ["Only a bounded public excerpt was available."],
        created_at: "2026-06-22T08:08:00.000Z",
      }],
    }),
    runFunctionToolPromptText: async (input) => {
      modelVisibleToolResult = await input.executeTool({
        name: "web_read",
        args: { url: "https://example.test/runtime-source" },
        rawArguments: JSON.stringify({ url: "https://example.test/runtime-source" }),
      });
      return "출처를 확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/evidence-transcript-privacy",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "출처를 확인해줘." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(JSON.stringify(modelVisibleToolResult)).toContain("raw payload strings");
  const toolResult = readTranscript("butler/main/evidence-transcript-privacy")
    .find((event) => event.kind === "tool_result" && event.payload.name === "web_read");
  const toolCall = readTranscript("butler/main/evidence-transcript-privacy")
    .find((event) => event.kind === "tool_call" && event.payload.name === "web_read");
  expect(toolCall?.payload.arguments).toMatchObject({
    schema_version: "butler.tool-call-arguments-transcript.v1",
    safe_arguments: {
      url: "https://example.test/runtime-source",
    },
  });
  expect(toolResult?.payload).toMatchObject({
    name: "web_read",
    ok: true,
  });
  expect(toolResult?.payload.result).toMatchObject({
    schema_version: "butler.tool-result-evidence-transcript.v1",
    evidence_capability_receipts: [expect.objectContaining({
      receipt_id: "ecr-runtime-source",
      schema_version: "evidence-capability.v1",
      satisfies: ["source_verified"],
    })],
    evidence_limitations: ["Only a bounded public excerpt was available."],
    completion_obligation_evidence: expect.objectContaining({
      limitations: ["Only a bounded public excerpt was available."],
    }),
  });

  const serialized = JSON.stringify(toolResult);
  expect(serialized).not.toContain("SECRET_TOKEN");
  expect(serialized).not.toContain("raw prompt text");
  expect(serialized).not.toContain("<think>");
  expect(serialized).not.toContain("/Users/private");
  expect(serialized).not.toContain("raw payload strings");
});

test("native runtime redacts raw tool failure errors in durable transcripts", async () => {
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async () => {
      throw new Error("failed with token=abc123opaque api_key=sk_live_abc123 raw prompt text <think>hidden</think> /Users/private/file");
    },
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "web_read",
        args: {
          url: "https://example.test/private-error",
          token: "abc123opaque",
        },
        rawArguments: JSON.stringify({ url: "https://example.test/private-error", token: "abc123opaque" }),
      });
      return "오류를 복구 가능한 결과로 받았습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/evidence-transcript-error-privacy",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "오류 redaction을 확인해줘." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  const transcript = readTranscript("butler/main/evidence-transcript-error-privacy");
  const toolCall = transcript.find((event) => event.kind === "tool_call" && event.payload.name === "web_read");
  const toolResult = transcript.find((event) => event.kind === "tool_result" && event.payload.name === "web_read");
  expect(toolCall?.payload.arguments).toMatchObject({
    schema_version: "butler.tool-call-arguments-transcript.v1",
    safe_arguments: {
      url: "https://example.test/private-error",
      token: "[redacted]",
    },
  });
  expect(toolResult?.payload).toMatchObject({
    ok: false,
    error: "Tool execution failed.",
  });
  const serialized = JSON.stringify(transcript);
  expect(serialized).not.toContain("abc123opaque");
  expect(serialized).not.toContain("sk_live_abc123");
  expect(serialized).not.toContain("raw prompt text");
  expect(serialized).not.toContain("<think>");
  expect(serialized).not.toContain("/Users/private");
});

test("native runtime satisfies source verification from tool capability audit contracts", async () => {
  const prompts: string[] = [];
  const executedTools: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      if (call.name === "list_tool_capabilities") {
        return {
          ok: true,
          capabilities: [{ name: "run_command", category: "command" }],
          evidence_capability_receipts: [capabilityReceipt({
            id: "ecr-tool-capability-catalog",
            producerName: "list_tool_capabilities",
            capability: "source_verified",
            evidenceKind: "project_state",
            satisfies: ["source_verified"],
            reference: { task_id: "tool-catalog" },
          })],
        };
      }
      return { ok: true };
    },
    runFunctionToolPromptText: async (input) => {
      prompts.push(input.prompt);
      if (prompts.length === 1) {
        await input.onAssistantTextBeforeTools?.({
          text: [
            "summary: 현재 네이티브 툴 카탈로그를 확인합니다.",
            "rationale: 사용자가 실제 보유 툴을 물었기 때문입니다.",
            "next_step: 확인된 카탈로그를 기준으로 답합니다.",
            "completion_obligations: source_verified",
          ].join("\n"),
          toolCalls: [{ name: "list_tool_capabilities", args: { include_disabled: true } }],
        });
        await input.executeTool({
          name: "list_tool_capabilities",
          args: { include_disabled: true },
          rawArguments: JSON.stringify({ include_disabled: true }),
        });
        return "현재 카탈로그를 확인했습니다.";
      }
      expect(input.prompt).toContain("Goal Completion Review");
      return "현재 카탈로그를 확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/tool-capability-source",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "지금 버틀러가 갖고있는 툴은 무엇인지 확인은 해본거야?" },
  });

  expect(result.text).toBe("현재 카탈로그를 확인했습니다.");
  expect(executedTools).toEqual(["list_tool_capabilities"]);
});

test("completion obligation guard accepts command-created CSV and chart artifacts", () => {
  expect(completionObligationIncompleteReason({
    audit: [{
      name: "run_command",
      args: {
        command: "python3 report.py",
        output_paths: ["report.csv", "chart.png"],
      },
      ok: true,
      result: {
        ok: true,
        exit_code: 0,
        durable_artifact_created: true,
        data_table_created: true,
        chart_rendered: true,
        verified_output_files: [
          { path: "report.csv", artifact_kind: "csv_file" },
          { path: "chart.png", artifact_kind: "chart_file" },
        ],
        artifact_kinds: ["csv_file", "chart_file"],
        evidence_capability_receipts: [
          capabilityReceipt({
            id: "ecr-report-command",
            producerName: "run_command",
            capability: "command_executed",
            evidenceKind: "execution_result",
            satisfies: ["command_executed"],
          }),
          capabilityReceipt({
            id: "ecr-report-artifact",
            producerName: "run_command",
            capability: "durable_artifact",
            evidenceKind: "artifact",
            satisfies: ["durable_artifact"],
            reference: { path: "report.csv" },
          }),
          capabilityReceipt({
            id: "ecr-report-table",
            producerName: "run_command",
            capability: "data_table_created",
            evidenceKind: "data_table",
            satisfies: ["data_table_created"],
            reference: { path: "report.csv" },
          }),
          capabilityReceipt({
            id: "ecr-report-chart",
            producerName: "run_command",
            capability: "chart_rendered",
            evidenceKind: "chart",
            satisfies: ["chart_rendered"],
            reference: { path: "chart.png" },
          }),
        ],
      },
    }],
    decisions: [{
      decisionId: "decision-1",
      summary: "확인한 값으로 파일과 차트를 생성합니다.",
      completionObligations: [
        "command_executed",
        "durable_artifact",
        "data_table_created",
        "chart_rendered",
      ],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  })).toBeNull();
});

test("completion obligation guard requires durable evidence even for inspection wording", () => {
  expect(completionObligationIncompleteReason({
    audit: [{
      name: "run_command",
      args: {
        command: "node -e \"verify ledger files\"",
      },
      ok: true,
      result: {
        ok: true,
        exit_code: 0,
        evidence_receipts: [{
          schema: "butler.evidence-receipt.v1",
          id: "receipt-ledger-check",
          producer: { kind: "tool", name: "run_command" },
          receiptType: "execution",
          verified: true,
          covers: ["command_execution"],
          summary: "Canonical Project Ledger files exist and repo-local ledger absence was verified.",
          references: [],
          satisfies: ["command_executed"],
        }],
      },
    }],
    decisions: [{
      decisionId: "decision-ledger-inspection",
      summary: "canonical Project Ledger 파일 존재와 repo-local .project-ledger 부재를 직접 검증합니다.",
      rationale: "기존 상태 확인 명령이며 새 산출물을 생성하지 않습니다.",
      nextStep: "검증된 경로와 상태를 최종 보고에 반영합니다.",
      completionObligations: ["command_executed", "durable_artifact"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  })).toBe("The turn still needs repair for missing public completion obligation(s): durable_artifact.");
});

test("completion obligation guard keeps accepted durable obligations for passive document checks", () => {
  expect(completionObligationIncompleteReason({
    audit: [{
      name: "run_command",
      args: {
        command: "node -e \"inspect written specs\"",
      },
      ok: true,
      result: {
        ok: true,
        exit_code: 0,
        evidence_receipts: [{
          schema: "butler.evidence-receipt.v1",
          id: "receipt-written-doc-check",
          producer: { kind: "tool", name: "run_command" },
          receiptType: "execution",
          verified: true,
          covers: ["execution_result"],
          summary: "Written specs were inspected.",
          references: [],
          satisfies: ["command_executed"],
        }],
      },
    }],
    decisions: [{
      decisionId: "decision-written-doc-check",
      summary: "작성된 로드맵·계획·스펙 문서 파일과 핵심 문구를 확인합니다.",
      rationale: "이미 만들어진 문서가 요청 범위를 담고 있는지 검증하는 단계입니다.",
      nextStep: "확인된 범위와 누락 여부를 최종 보고합니다.",
      completionObligations: ["command_executed", "durable_artifact"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  })).toBe("The turn still needs repair for missing public completion obligation(s): durable_artifact.");
});

test("completion obligation guard keeps accepted durable obligations for writing-scope review", () => {
  expect(completionObligationIncompleteReason({
    audit: [{
      name: "run_command",
      args: {
        command: "node -e \"check ledger scope\"",
      },
      ok: true,
      result: {
        ok: true,
        exit_code: 0,
        evidence_receipts: [{
          schema: "butler.evidence-receipt.v1",
          id: "receipt-writing-scope-check",
          producer: { kind: "tool", name: "run_command" },
          receiptType: "execution",
          verified: true,
          covers: ["execution_result"],
          summary: "Ledger scope was checked.",
          references: [],
          satisfies: ["command_executed"],
        }],
      },
    }],
    decisions: [{
      decisionId: "decision-writing-scope-check",
      summary: "Butler Home의 Project Ledger 상태와 기존 관련 작업을 먼저 확인합니다.",
      rationale: "이미 존재하는 ledger 상태 확인입니다.",
      nextStep: "확인된 ledger 상태를 기준으로 문서 위치와 작성 범위를 좁힙니다.",
      completionObligations: ["command_executed", "durable_artifact"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  })).toBe("The turn still needs repair for missing public completion obligation(s): durable_artifact.");
});

test("completion obligation guard still requires durable evidence for creation decisions", () => {
  expect(completionObligationIncompleteReason({
    audit: [{
      name: "run_command",
      args: {
        command: "node -e \"write report\"",
      },
      ok: true,
      result: {
        ok: true,
        exit_code: 0,
        evidence_receipts: [{
          schema: "butler.evidence-receipt.v1",
          id: "receipt-report-command",
          producer: { kind: "tool", name: "run_command" },
          receiptType: "execution",
          verified: true,
          covers: ["execution_result"],
          summary: "Report generation command executed.",
          references: [],
          satisfies: ["command_executed"],
        }],
      },
    }],
    decisions: [{
      decisionId: "decision-report-create",
      summary: "검증 결과를 새 보고서 파일로 작성합니다.",
      rationale: "사용자가 저장된 산출물을 요청했습니다.",
      nextStep: "보고서 파일을 저장한 뒤 최종 보고합니다.",
      completionObligations: ["command_executed", "durable_artifact"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  })).toBe("The turn still needs repair for missing public completion obligation(s): durable_artifact.");
});

test("completion obligation guard accepts generic evidence receipts for non-CSV deliverables", () => {
  expect(completionObligationIncompleteReason({
    audit: [{
      name: "run_command",
      args: { command: "python3 render_report.py" },
      ok: true,
      result: {
        ok: true,
        evidence_receipts: [{
          schema: "butler.evidence-receipt.v1",
          id: "receipt-report-pdf",
          producer: { kind: "tool", name: "run_command" },
          receiptType: "deliverable",
          verified: true,
          covers: ["durable_deliverable"],
          summary: "A PDF report artifact was rendered.",
          references: [],
          artifacts: [{
            label: "report.pdf",
            path: "report.pdf",
            mediaType: "application/pdf",
            role: "report",
          }],
          satisfies: ["durable_artifact"],
        }],
      },
    }],
    decisions: [{
      decisionId: "decision-pdf",
      summary: "확인한 내용을 PDF 산출물로 렌더링합니다.",
      completionObligations: ["durable_artifact"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  })).toBeNull();
});

test("completion obligation guard rejects executable-code substitutes structurally", () => {
  const reason = completionObligationIncompleteReason({
    audit: [{
      name: "web_read",
      args: { url: "https://example.test/population" },
      ok: true,
      result: { source_url: "https://example.test/population" },
    }],
    decisions: [{
      decisionId: "decision-1",
      summary: "수집된 인구 데이터를 바탕으로 실제 차트 이미지를 생성합니다.",
      rationale: "사용자는 코드 예제가 아니라 실행된 결과를 요청했습니다.",
      nextStep: "생성된 차트 파일과 CSV 데이터를 바탕으로 최종 보고서를 완성합니다.",
      completionObligations: ["source_verified", "command_executed"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  });

  expect(reason).toContain("command_executed");
});

test("completion obligation guard rejects local execution substitutes structurally", () => {
  const reason = completionObligationIncompleteReason({
    audit: [{
      name: "web_read",
      args: { url: "https://example.test/population" },
      ok: true,
      result: { source_url: "https://example.test/population" },
    }],
    decisions: [{
      decisionId: "decision-1",
      summary: "확인한 데이터를 실행 도구로 시각화합니다.",
      completionObligations: ["command_executed", "chart_rendered"],
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  });

  expect(reason).toContain("command_executed");
  expect(reason).toContain("chart_rendered");
});

test("completion obligation guard allows educational code examples without protocol obligations", () => {
  expect(completionObligationIncompleteReason({
    audit: [],
    decisions: [],
  })).toBeNull();
});

test("native runtime refuses delivered when artifact review keeps returning text-environment apology", async () => {
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async () => ({
      source_url: "https://example.test/population",
      title: "인구 통계",
      text: "서울 9300000 부산 3300000 인천 3000000",
    }),
    runFunctionToolPromptText: async (input) => {
      if (!input.prompt.includes("Goal Completion Review")) {
        await input.onAssistantTextBeforeTools?.({
          text: "summary: 공개 출처 본문을 확인합니다.\nrationale: 수치가 실제 본문 근거를 가져야 합니다.\nnext_step: 확인한 수치로 CSV 파일과 차트 이미지를 생성합니다.\ncompletion_obligations: source_verified, command_executed",
          toolCalls: [{ name: "web_read", args: { url: "https://example.test/population" } }],
        });
        await input.executeTool({
          name: "web_read",
          args: { url: "https://example.test/population" },
          rawArguments: JSON.stringify({ url: "https://example.test/population" }),
        });
      }
      return "CSV는 본문에 적었고, matplotlib 차트는 텍스트 기반 응답 환경이라 이미지 파일로 직접 제공해 드리지 못합니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/artifact-downgrade",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await expect(runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "local/gemma-4",
    input: { text: "공개 자료를 확인하고 CSV와 matplotlib 차트를 만들어 보고해 주세요." },
  })).rejects.toThrow("command_executed");
});

test("native runtime refuses delivered when artifact review returns executable code instead of running it", async () => {
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async () => ({
      source_url: "https://example.test/population",
      title: "인구 통계",
      text: "서울 9300000 부산 3300000 인천 3000000",
    }),
    runFunctionToolPromptText: async (input) => {
      if (!input.prompt.includes("Goal Completion Review")) {
        await input.onAssistantTextBeforeTools?.({
          text: [
            "summary: 수집된 인구 데이터를 바탕으로 실제 matplotlib 차트 이미지를 생성하고 CSV 파일로 저장합니다.",
            "rationale: 사용자는 단순히 코드를 받는 것이 아니라 차트를 그린 결과를 요청했습니다.",
            "next_step: 생성된 차트 파일과 CSV 데이터를 바탕으로 최종 보고서를 완성합니다.",
            "completion_obligations: source_verified, command_executed",
          ].join("\n"),
          toolCalls: [{ name: "web_read", args: { url: "https://example.test/population" } }],
        });
        await input.executeTool({
          name: "web_read",
          args: { url: "https://example.test/population" },
          rawArguments: JSON.stringify({ url: "https://example.test/population" }),
        });
      }
      return [
        "요청하신 데이터를 바탕으로 차트 코드를 작성했습니다.",
        "```python",
        "import matplotlib.pyplot as plt",
        "plt.bar(['Seoul', 'Busan', 'Incheon'], [9400000, 3300000, 3000000])",
        "plt.show()",
        "```",
      ].join("\n");
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/artifact-code-substitute",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await expect(runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "local/gemma-4",
    input: { text: "공개 자료를 확인하고 CSV와 matplotlib 차트를 만들어 보고해 주세요." },
  })).rejects.toThrow("command_executed");
});

test("native runtime can disable default completion review through typed metadata", async () => {
  const attempts: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    executeButlerTool: async () => ({ ok: true }),
    runFunctionToolPromptText: async (input) => {
      attempts.push(input.prompt);
      await input.onAssistantTextBeforeTools?.({
        text: "Work: Checking public evidence.\nWhy: The answer should be grounded.\nNext: Use the result in the final.",
        toolCalls: [{ name: "web_search", args: { query: "example" } }],
      });
      await input.executeTool({
        name: "web_search",
        args: { query: "example" },
        rawArguments: JSON.stringify({ query: "example" }),
      });
      return "Finished from the first pass.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "local/gemma-4",
    input: { text: "Check this with a tool." },
    metadata: {
      runtimePolicy: {
        completionReview: "disabled",
      },
    },
  });

  expect(result.text).toBe("Finished from the first pass.");
  expect(attempts).toHaveLength(1);
  expect(attempts.some((prompt) => prompt.includes("Goal Completion Review"))).toBe(false);
});

test("completion review incomplete marker is parsed as a safe failure reason", () => {
  expect(completionReviewIncompleteReason("INCOMPLETE: source access was unavailable.")).toBe(
    "source access was unavailable.",
  );
  expect(completionReviewIncompleteReason("미완료: 확인 가능한 도구 결과가 없습니다.")).toBe(
    "확인 가능한 도구 결과가 없습니다.",
  );
  expect(completionReviewIncompleteReason("The outcome is complete.")).toBeNull();
});

test("native runtime leaves CSV public-data tool choice to the model unless explicitly required", async () => {
  const attempts: string[] = [];
  const executedTools: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      if (call.name === "web_search") {
        return {
          results: [
            { title: "주민등록 인구통계", url: "https://example.test/population" },
          ],
          source_urls: ["https://example.test/population"],
        };
      }
      return { ok: true };
    },
    runFunctionToolPromptText: async (input) => {
      attempts.push(input.prompt);
      expect(input.prompt).not.toContain("Public Data Table Workflow Repair");
      if (input.prompt.includes("Goal Completion Review")) {
        return [
          "공개 인구 데이터 예시를 CSV 보고서 형식으로 간단히 정리했습니다.",
          "",
          "```csv",
          "city,population_sample",
          "서울특별시,9300000",
          "부산광역시,3300000",
          "인천광역시,3000000",
          "```",
          "",
          "출처 후보: https://example.test/population",
        ].join("\n");
      }
      await input.onAssistantTextBeforeTools?.({
        text: "summary: 공개 인구 데이터의 근거 후보를 확인합니다.\nrationale: 보고서의 숫자 예시는 공개 출처에 기대야 합니다.\nnext_step: 확인한 출처를 기준으로 결과만 요약합니다.",
        toolCalls: [{ name: "web_search", args: { query: "대한민국 주요 도시 인구 공개 데이터" } }],
      });
      await input.executeTool({
        name: "web_search",
        args: { query: "대한민국 주요 도시 인구 공개 데이터" },
        rawArguments: JSON.stringify({ query: "대한민국 주요 도시 인구 공개 데이터" }),
      });
      return [
        "공개 인구 데이터 예시를 CSV 보고서 형식으로 간단히 정리했습니다.",
        "",
        "```csv",
        "city,population_sample",
        "서울특별시,9300000",
        "부산광역시,3300000",
        "인천광역시,3000000",
        "```",
        "",
        "출처 후보: https://example.test/population",
      ].join("\n");
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "local/gemma-4",
    input: {
      text: "공개 데이터와 CSV 보고서 형식으로 한국 주요 도시 인구 예시를 간단히 정리해 주세요. 필요하면 공개 웹에서 확인해 주세요.",
    },
  });

  expect(attempts.some((prompt) => prompt.includes("Public Data Table Workflow Repair"))).toBe(false);
  expect(executedTools).toEqual(["web_search"]);
  expect(executedTools).not.toContain("transform_public_data_table");
  expect(result.text).toContain("CSV 보고서 형식");
});

test("native runtime lets the model expand local conversation context when the model selects the tool", async () => {
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: "butler/main",
    kind: "inbound",
    eventId: "event-old-1",
    payload: {
      message: { text: "처음에 항목A는 2단계이고 항목B은 기본이라고 말했어요." },
    },
  }));
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: "butler/main",
    kind: "outbound",
    eventId: "event-old-2",
    payload: {
      message: { text: "네, 항목A 2단계과 항목B 기본으로 기억하겠습니다." },
    },
  }));
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: "butler/main",
    kind: "inbound",
    eventId: "event-current",
    payload: {
      message: { text: "위에서 항목A 몇 돌이라고 했지?" },
    },
  }));

  let capturedPrompt = "";
  const runtime = new NativeToolLoopRuntime({
    recentConversationTokenBudget: 1,
    runFunctionToolPromptText: async (input) => {
      capturedPrompt = input.prompt;
      expect(input.prompt).not.toContain("Conversation context may be under-specified");
      const context = await input.executeTool({
        name: "read_conversation_context",
        args: { query: "항목A", limit: 4 },
        rawArguments: "{\"query\":\"항목A\",\"limit\":4}",
      }) as { events: Array<{ text: string }> };
      expect(context.events.some((event) => event.text.includes("항목A는 2단계"))).toBe(true);
      return "항목A는 2단계이라고 말씀하셨습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "event-current",
      accountId: "default",
      transport: "telegram",
      peer: { kind: "dm", id: "1" },
      sender: { id: "1" },
      message: {
        id: "event-current",
        text: "위에서 항목A 몇 돌이라고 했지?",
        timestamp: new Date().toISOString(),
      },
    },
  });

  expect(capturedPrompt).toContain("## Recent Conversation");
  expect(result.text).toBe("항목A는 2단계이라고 말씀하셨습니다.");
  expect(readTranscript("butler/main").some((event) =>
    event.kind === "tool_call" &&
    event.payload.name === "read_conversation_context",
  )).toBe(true);
});

test("native runtime does not inject semantic runtime policies from multilingual keyword wording", async () => {
  const prompts: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      throw new Error("unexpected tool " + call.name);
    },
    runFunctionToolPromptText: async (input) => {
      prompts.push(input.prompt);
      return "언어별 단어사전 없이 모델의 의미 판단에 맡깁니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  for (const text of [
    "내일 서울 날씨 어때?",
    "What is the current sample price?",
    "¿Cuál es el clima de Madrid mañana?",
    "Quali sono le notizie principali di oggi?",
    "今日の東京の天気を教えて",
  ]) {
    const result = await runtime.runTurn({
      handle,
      provider: fakeProvider,
      model: "openai/auto:codex-latest",
      input: { text },
    });
    expect(result.text).toContain("모델의 의미 판단");
  }

  expect(prompts).toHaveLength(5);
  for (const prompt of prompts) {
    expect(prompt).not.toContain("Runtime Evidence Policy");
    expect(prompt).not.toContain("Freshness evidence required");
    expect(prompt).not.toContain("Correction challenge policy");
    expect(prompt).not.toContain("Short utterance intent policy");
    expect(prompt).not.toContain("Conversation context may be under-specified");
  }
  expect(readOperationalMetricEvents({ butlerData: tempDir })
    .filter((event) => event.name === "intent_guard")).toHaveLength(0);
});

test("runtime semantic guard helpers are no-ops without structural policy metadata", () => {
  const correction = applyCorrectionChallengeGuard({
    userText: "그거 아냐",
    responseText: "맞습니다. 사용자님 말씀이 맞습니다. 제가 틀렸습니다. 정정하겠습니다.",
    audit: [],
    language: "ko",
  });
  expect(correction).toContain("사용자님 말씀이 맞습니다");

  const shortCue = applyShortCueRhythmGuard({
    userText: "짧은 호출!",
    responseText: "짧은 호출.\n\n테스트 사용자님, 호출하셨습니까?",
    language: "ko",
  });
  expect(shortCue).toBe("짧은 호출.\n\n테스트 사용자님, 호출하셨습니까?");

  const shortCorrection = applyShortUtteranceCorrectionGuard({
    userText: "유파",
    responseText: "맞습니다. 제가 틀렸습니다. 앞선 답변을 정정하겠습니다.",
    language: "ko",
  });
  expect(shortCorrection).toContain("제가 틀렸습니다");
});

test("native runtime records safe context monitor telemetry for each turn", async () => {
  let capturedPrompt = "";
  const runtime = new NativeToolLoopRuntime({
    recallMemory: () => ({
      cue: "오늘 결정 기억해?",
      seeds: ["오늘"],
      abstained: false,
      diagnostics: ["fixture"],
      items: [{
        summary: "이전 결정 요약",
        confidence: 0.9,
        source: "hybrid",
        originalSource: "hot-cache",
        provenance: ["test"],
        related_nodes: ["decision"],
        score_breakdown: {
          semantic_similarity: 0.9,
          lexical_match: 0,
          contextual_match: 0,
          graph_activation: 0.5,
          recency_score: 0.5,
          frequency_score: 0,
          explicit_salience: 0,
          evidence_confidence: 0.9,
          decision_preference_boost: 0,
          hub_penalty: 0,
          conflict_penalty: 0,
          stale_superseded_penalty: 0,
          total: 0.9,
        },
      }],
    }),
    runFunctionToolPromptText: async (input) => {
      capturedPrompt = input.prompt;
      return "기억하고 있습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "오늘 결정 기억해?" },
    metadata: { promptContext: "SAFE_CONTEXT_HINT" },
  });

  const summary = readContextMonitor({ butlerData: tempDir, sessionId: "butler/main" });

  expect(summary.latestTurn).toMatchObject({
    model: "openai/auto:codex-latest",
    totalPromptChars: capturedPrompt.length,
    promptContextChars: "SAFE_CONTEXT_HINT".length,
    inboundMessageChars: "오늘 결정 기억해?".length,
  });
  expect(summary.latestTurn?.recallContextChars).toBeGreaterThan(0);
  expect(readFileSync(join(tempDir, "metrics", "context-monitor.jsonl"), "utf8"))
    .not.toContain("오늘 결정 기억해?");
});

test("native runtime default automatic recall uses vector-capable recall", async () => {
  const vectorRequests: Array<Record<string, unknown>> = [];
  let capturedPrompt = "";
  const runtime = new NativeToolLoopRuntime({
    recallMemoryWithVector: async (input) => {
      vectorRequests.push(input);
      return {
        cue: input.cue,
        seeds: ["웹", "리더"],
        abstained: false,
        diagnostics: ["vector=ok"],
        items: [{
          summary: "웹 리더 본문 노이즈는 하이브리드 추출, confidence, raw fallback으로 줄인다.",
          confidence: 0.91,
          source: "vector",
          provenance: ["vector:s-reader:reader-vector"],
          related_nodes: [],
          score_breakdown: {
            semantic_similarity: 0.91,
            lexical_match: 0,
            contextual_match: 0,
            graph_activation: 0,
            recency_score: 0.5,
            frequency_score: 0,
            explicit_salience: 0,
            evidence_confidence: 0.91,
            decision_preference_boost: 0,
            hub_penalty: 0,
            conflict_penalty: 0,
            stale_superseded_penalty: 0,
            total: 0.91,
          },
        }],
      };
    },
    runFunctionToolPromptText: async (input) => {
      capturedPrompt = input.prompt;
      return "확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
    metadata: { projectId: "butler" },
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "웹 리더 본문 노이즈 줄이는 접근 기억해?" },
  });

  expect(vectorRequests).toEqual([expect.objectContaining({
    butlerData: tempDir,
    cue: "웹 리더 본문 노이즈 줄이는 접근 기억해?",
    projectId: "butler",
    limit: 4,
    vectorTimeoutMs: 1500,
  })]);
  expect(capturedPrompt).toContain("## Associative Recall Context");
  expect(capturedPrompt).toContain("source=vector");
});

test("native runtime injects compact associative recall context when useful", async () => {
  let capturedPrompt = "";
  const runtime = new NativeToolLoopRuntime({
    recallMemory: () => ({
      cue: "떡볶이 먹고 싶다",
      seeds: ["떡볶이"],
      abstained: false,
      diagnostics: ["fixture"],
      items: [{
        summary: "지난번에는 로제 떡볶이를 골랐고 최근 저탄수 목표도 있다.",
        confidence: 0.82,
        source: "hybrid",
        originalSource: "graph",
        provenance: ["graph:food", "transcript:diet"],
        related_nodes: ["tteokbokki", "low-carb-goal"],
        score_breakdown: {
          semantic_similarity: 0.8,
          lexical_match: 0,
          contextual_match: 0,
          graph_activation: 0.7,
          recency_score: 0.5,
          frequency_score: 0.2,
          explicit_salience: 0,
          evidence_confidence: 0.8,
          decision_preference_boost: 0.18,
          hub_penalty: 0,
          conflict_penalty: 0,
          stale_superseded_penalty: 0,
          total: 0.82,
        },
      }],
    }),
    runFunctionToolPromptText: async (input) => {
      capturedPrompt = input.prompt;
      return "지난번 취향과 현재 목표를 함께 보겠습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      text: "떡볶이 먹고 싶다",
    },
  });

  expect(capturedPrompt).toContain("## Associative Recall Context");
  expect(capturedPrompt).toContain("로제 떡볶이");
  expect(capturedPrompt).toContain("provenance=graph:food, transcript:diet");
});

test("native runtime lets the model choose recall before exact memory query", async () => {
  const executedTools: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      if (call.name === "recall_memory") {
        return {
          cue: call.args.cue,
          seeds: ["처음", "대화"],
          abstained: false,
          diagnostics: ["fixture"],
          items: [{
            summary: "첫 대화는 연결 테스트와 자기소개 주변 기록으로 시작했다.",
            confidence: 0.8,
            source: "hybrid",
            originalSource: "graph",
            provenance: ["graph:first-chat"],
            related_nodes: ["first-chat"],
            score_breakdown: {
              semantic_similarity: 0.7,
              lexical_match: 0,
              contextual_match: 0,
              graph_activation: 0.6,
              recency_score: 0.5,
              frequency_score: 0.2,
              explicit_salience: 0,
              evidence_confidence: 0.7,
              decision_preference_boost: 0,
              hub_penalty: 0,
              conflict_penalty: 0,
              stale_superseded_penalty: 0,
              total: 0.8,
            },
          }],
        };
      }
      return { ok: true, tool: call.name };
    },
    runFunctionToolPromptText: async (input) => {
      await input.onAssistantTextBeforeTools?.({
        text: "summary: 이전 대화 단서를 먼저 회상합니다.\nrationale: 모델이 연상 후보가 필요하다고 판단했습니다.\nnext_step: 회상 후보를 정확한 날짜 근거로 검증합니다.",
        toolCalls: [{
          name: "recall_memory",
          args: { cue: "우리가 처음 대화를 나눈 날에 어떤 이야기를 했는지 기억해?" },
        }],
      });
      await input.executeTool({
        name: "recall_memory",
        args: { cue: "우리가 처음 대화를 나눈 날에 어떤 이야기를 했는지 기억해?" },
        rawArguments: JSON.stringify({ cue: "우리가 처음 대화를 나눈 날에 어떤 이야기를 했는지 기억해?" }),
      });
      await input.onAssistantTextBeforeTools?.({
        text: "summary: 첫 대화 날짜를 정확히 확인합니다.\nrationale: 연상 후보를 날짜 근거로 검증해야 합니다.\nnext_step: 조회 결과로 답합니다.",
        toolCalls: [{ name: "query_memory", args: { order: "earliest", limit: 1 } }],
      });
      await input.executeTool({
        name: "query_memory",
        args: { order: "earliest", limit: 1 },
        rawArguments: JSON.stringify({ order: "earliest", limit: 1 }),
      });
      return "확인된 첫 대화는 2026-04-24입니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      text: "우리가 처음 대화를 나눈 날에 어떤 이야기를 했는지 기억해?",
    },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(result.text).toContain("2026-04-24");
  expect(executedTools).toEqual(["recall_memory", "query_memory"]);
  expect(readTranscript("butler/main")
    .filter((event) => event.kind === "tool_call")
    .map((event) => event.payload.name)).toEqual(["recall_memory", "query_memory"]);
});

test("native runtime uses structured current user text for gateway memory recall", async () => {
  const actualCue = "우리가 처음 대화를 나눈 날에 어떤 이야기를 했는지 기억해?";
  const promptContextText = "이 텍스트를 파싱하면 안 됩니다.";
  const recallCues: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    executeButlerTool: async (call) => {
      if (call.name === "recall_memory") {
        recallCues.push(typeof call.args.cue === "string" ? call.args.cue : "");
        return {
          cue: call.args.cue,
          seeds: [],
          items: [],
          abstained: true,
          diagnostics: [],
        };
      }
      return { ok: true, tool: call.name };
    },
    runFunctionToolPromptText: async (input) => {
      expect(input.prompt).toContain(actualCue);
      expect(input.prompt).not.toContain(promptContextText);
      await input.executeTool({
        name: "recall_memory",
        args: { cue: actualCue },
        rawArguments: JSON.stringify({ cue: actualCue }),
      });
      await input.executeTool({
        name: "query_memory",
        args: { order: "earliest", limit: 1 },
        rawArguments: JSON.stringify({ order: "earliest", limit: 1 }),
      });
      return "확인된 첫 대화는 2026-04-24입니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/app-chat-structured-input",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "app:structured-current-text",
      accountId: "local",
      transport: "app",
      peer: { kind: "dm", id: "chat-structured-input" },
      sender: { id: "app-user" },
      message: {
        id: "client-structured-current-text",
        text: "",
        timestamp: new Date().toISOString(),
      },
    },
    metadata: {
      currentUserText: actualCue,
      promptContext: `## Current User Input\n\nMessage Text: ${promptContextText}`,
      runtimePolicy: { completionReview: "disabled" },
    },
  });

  expect(recallCues).toEqual([actualCue]);
  const events = readTranscript("butler/app-chat-structured-input");
  expect(events
    .filter((event) => event.kind === "tool_call")
    .map((event) => event.payload.name)).toEqual(["recall_memory", "query_memory"]);
  const queryResult = events.find((event) =>
    event.kind === "tool_result" && event.payload.name === "query_memory");
  expect(queryResult?.payload.result).not.toHaveProperty("associative_recall_evidence");
});

test("native runtime skips associative recall context when recall abstains", async () => {
  let capturedPrompt = "";
  const runtime = new NativeToolLoopRuntime({
    recallMemory: () => ({
      cue: "지금 몇시야?",
      seeds: ["지금", "몇시"],
      abstained: true,
      diagnostics: ["abstained=low-confidence"],
      items: [],
    }),
    runFunctionToolPromptText: async (input) => {
      capturedPrompt = input.prompt;
      return "시간을 확인하겠습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      text: "지금 몇시야?",
    },
  });

  expect(capturedPrompt).not.toContain("## Associative Recall Context");
});

test("native runtime skips associative recall for system text turns", async () => {
  let recallCalls = 0;
  let capturedPrompt = "";
  const runtime = new NativeToolLoopRuntime({
    recallMemory: () => {
      recallCalls += 1;
      throw new Error("system text must not call recall");
    },
    runFunctionToolPromptText: async (input) => {
      capturedPrompt = input.prompt;
      return "복구 이벤트를 처리했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      text: "worker completion resume",
    },
    metadata: {
      eventKind: "system",
    },
  });

  expect(recallCalls).toBe(0);
  expect(capturedPrompt).not.toContain("## Associative Recall Context");
});

test("native runtime degrades gracefully when associative recall fails", async () => {
  let capturedPrompt = "";
  const runtime = new NativeToolLoopRuntime({
    recallMemory: () => {
      throw new Error("graph temporarily unavailable");
    },
    runFunctionToolPromptText: async (input) => {
      capturedPrompt = input.prompt;
      return "계속 진행하겠습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      text: "이전 결정 기억나?",
    },
  });

  expect(result.text).toBe("계속 진행하겠습니다.");
  expect(capturedPrompt).not.toContain("## Associative Recall Context");
});

test("native runtime prompt describes direct versus planned dispatch choices", async () => {
  let capturedInstructions = "";
  const runtime = new NativeToolLoopRuntime({
    runFunctionToolPromptText: async (input) => {
      capturedInstructions = input.instructions ?? "";
      return "계획을 세우겠습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      text: "프로젝트 구조를 분석하고 개선안을 정리해줘",
    },
  });

  expect(capturedInstructions).toContain("create_planned_task");
  expect(capturedInstructions).toContain("planned dispatch");
  expect(capturedInstructions).toContain("dispatch_worker");
  expect(capturedInstructions).toContain("critical decision");
  expect(capturedInstructions).toContain("one to three searches");
  expect(capturedInstructions).toContain("completion_claim_allowed");
  expect(capturedInstructions).toContain("list_tool_capabilities");
  expect(capturedInstructions).toContain("create_work_orchestration");
  expect(capturedInstructions).toContain("bounded interactive requests");
  expect(capturedInstructions).toContain("same-turn report");
  expect(capturedInstructions).toContain("`report` field containing the final user-facing answer");
  expect(capturedInstructions).toContain("do not publish Review/PASS evidence");
  expect(capturedInstructions).toContain("visible turn-local tools");
  expect(capturedInstructions).toContain("Do not replace this with a background worker heartbeat");
  expect(capturedInstructions).toContain("choose and call the appropriate tool");
  expect(capturedInstructions).toContain("Do not ask the user to name the tool");
  expect(capturedInstructions).toContain("JSON-safe");
  expect(capturedInstructions).toContain("multiple short commands");
  expect(capturedInstructions).toContain("case-insensitive search");
  expect(capturedInstructions).toContain("Do not conclude that something is absent from a single exact case-sensitive text match");
  expect(capturedInstructions).toContain("Butler Turn Cognition Cycle");
  expect(capturedInstructions).toContain("`구상`, `계획`, `실행`, `검토`, `취합 및 정리`, `보고`");
  expect(capturedInstructions).toContain("expected final deliverable");
  expect(capturedInstructions).toContain("Default Response Shape");
  expect(capturedInstructions).toContain("one to three short paragraphs");
  expect(capturedInstructions).toContain("Do not expand the internal BTCC cycle");
  expect(capturedInstructions).toContain("recall_memory");
  expect(capturedInstructions).toContain("query_memory");
  expect(capturedInstructions).toContain("loosely referenced prior-conversation memory questions");
  expect(capturedInstructions).toContain("decide whether associative recall is needed");
  expect(capturedInstructions).toContain("Use `recall_memory` when associative candidate evidence is needed");
  expect(capturedInstructions).not.toContain("You must call `recall_memory` before exact transcript lookup");
  expect(capturedInstructions).toContain("Do not use `run_command` to scan Butler transcript files");
  expect(capturedInstructions).toContain("Domain-specific tool preferences belong in structured capability");
  expect(capturedInstructions).not.toContain("get_weather_with_knowhow");
  expect(capturedInstructions).not.toContain("weather questions");
  expect(capturedInstructions).not.toMatch(/\bweather\b/iu);
  expect(capturedInstructions).not.toContain("Broad project/repository/codebase investigations");
  expect(capturedInstructions).not.toMatch(/E2E|validation token|WORKSTREAM_E2E/u);
});

test("native runtime exposes Project Ledger project context without forcing tool order", async () => {
  const prompts: string[] = [];
  const executed: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    butlerHome: process.cwd(),
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      executed.push(call.name);
      if (call.name === "inspect_project_status") {
        return { ok: true, project: { id: "butler" }, issueCount: 0 };
      }
      if (call.name === "query_project_work") {
        return { ok: true, kind: call.args.kind, results: [] };
      }
      if (call.name === "create_planned_task") {
        return { ok: true, task_id: "planned-quality" };
      }
      if (call.name === "run_planned_task") {
        return {
          ok: true,
          task_id: "planned-quality",
          worker_task_id: "worker-quality",
          status: "PLANNED_RUNNING",
        };
      }
      return { ok: true };
    },
    runFunctionToolPromptText: async (input) => {
      prompts.push(input.prompt);
      const plannedTaskArgs = {
        title: "품질 조정",
        task: "프로젝트 세션 품질 조정을 구현한다.",
        acceptance_criteria: ["Ledger 상태와 작업 조회 뒤 계획 작업을 시작한다."],
      };
      await input.executeTool({
        name: "inspect_project_status",
        args: {},
        rawArguments: "{}",
      });
      await input.executeTool({
        name: "query_project_work",
        args: { kind: "next-actions" },
        rawArguments: "{\"kind\":\"next-actions\"}",
      });
      await input.executeTool({
        name: "create_planned_task",
        args: plannedTaskArgs,
        rawArguments: "{\"title\":\"품질 조정\"}",
      });
      await input.executeTool({
        name: "run_planned_task",
        args: { task_id: "planned-quality" },
        rawArguments: "{\"task_id\":\"planned-quality\"}",
      });
      return "계획형 작업을 시작했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/project-feature-policy",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
    metadata: { projectId: "butler" },
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      text: "버틀러 프로젝트 세션 품질을 조정하고 구현해줘.",
    },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(prompts[0]).toContain("Project Ledger Runtime Context");
  expect(prompts[0]).not.toContain("project-session-feature-work-ledger-reviewed-dispatch");
  expect(executed).toEqual([
    "inspect_project_status",
    "query_project_work",
    "create_planned_task",
    "run_planned_task",
  ]);
  expect(result.text).toBe("계획형 작업을 시작했습니다.");
});

test("native runtime does not force broad project investigations into planned dispatch", async () => {
  const prompts: string[] = [];
  const executed: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    butlerHome: process.cwd(),
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      executed.push(call.name);
      if (call.name === "run_command") {
        return {
          ok: true,
          exit_code: 0,
          stdout: "packages/butler-agent/src/agent/turn/native-tool-loop.ts\npackages/butler-agent/src/agent/tools/butler-tools.ts\n",
          stderr: "",
        };
      }
      return { ok: true };
    },
    runFunctionToolPromptText: async (input) => {
      prompts.push(input.prompt);
      expect(input.tools.map((tool) => tool.name)).toContain("run_command");
      await input.executeTool({
        name: "run_command",
        args: { command: "find . -maxdepth 2 -type f" },
        rawArguments: "{\"command\":\"find . -maxdepth 2 -type f\"}",
      });
      return "프로젝트 조사를 완료했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/broad-project-investigation",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
    metadata: { projectId: "project-test" },
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      text: "이 프로젝트에 대해서 자세히 조사해보고 어떤 프로젝트인지, 특징이 무엇인지, 어디까지 구현되었는지, 강점과 약점을 정리해줘.",
    },
    metadata: {
      runtimePolicy: {
        completionReview: "disabled",
        requiredNativeTools: ["run_command"],
      },
    },
  });

  expect(prompts[0]).not.toContain("Runtime Routing Policy");
  expect(prompts[0]).not.toContain("broad-project-investigation-reviewed-dispatch");
  expect(prompts[0]).not.toContain("Runtime Routing Policy Repair");
  expect(executed).toContain("run_command");
  expect(executed).not.toContain("create_planned_task");
  expect(executed).not.toContain("run_planned_task");
  expect(executed).not.toContain("dispatch_worker");
  expect(result.text).toBe("프로젝트 조사를 완료했습니다.");
});

test("native runtime stops executing tools after turn cancellation", async () => {
  const controller = new AbortController();
  const executed: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    executeButlerTool: async (call) => {
      executed.push(call.name);
      return { ok: true };
    },
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "run_command",
        args: { command: "pwd" },
        rawArguments: "{\"command\":\"pwd\"}",
      });
      controller.abort();
      await input.executeTool({
        name: "create_planned_task",
        args: {
          goal: "This planned task must not be created after cancellation.",
          acceptance_criteria: ["No planned work after cancel."],
        },
        rawArguments: "{}",
      });
      return "should not deliver";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/cancel-stops-tools",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await expect(runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "start then cancel" },
    signal: controller.signal,
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  })).rejects.toThrow("Runtime turn was cancelled.");

  expect(executed).toEqual(["run_command"]);
});

test("runtime does not rewrite worker or task claims through language dictionaries", () => {
  expect(enforceGroundedActionClaims({
    userText: "워커로 확인해줘",
    responseText: "워커를 시작했습니다. 완료되면 보고드리겠습니다.",
    audit: [],
    language: "ko",
  })).toBe("워커를 시작했습니다. 완료되면 보고드리겠습니다.");

  expect(enforceGroundedActionClaims({
    userText: "Please dispatch a worker.",
    responseText: "I started a worker in the background.",
    audit: [],
  })).toBe("I started a worker in the background.");
});

test("native runtime appends sources when web search informed the answer", () => {
  const text = applyWebSearchCitationGuard({
    text: "OpenAI documentation is the best source for current API behavior.",
    audit: [{
      name: "web_search",
      args: { query: "OpenAI docs" },
      ok: true,
      result: {
        source_urls: ["https://platform.openai.com/docs"],
      },
    }],
  });

  expect(text).toContain("Sources:");
  expect(text).toContain("[https://platform.openai.com/docs](https://platform.openai.com/docs)");
});

test("runtime does not repair freshness-like wording through keyword dictionaries", async () => {
  const prompts: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      throw new Error("unexpected tool " + call.name);
    },
    runFunctionToolPromptText: async (input) => {
      prompts.push(input.prompt);
      return "모델이 도구를 선택하지 않았으므로 런타임이 검색을 강제하지 않습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  for (const text of [
    "항목B999 vs 항목C 누구뽑을까",
    "오늘 내가 꼭 알아야할 세계 정세 뉴스들이 있을까",
    "항목D의 명대사 한번만 해줘",
    "Quali sono le notizie principali di oggi?",
    "今日の東京の天気を教えて",
  ]) {
    const result = await runtime.runTurn({
      handle,
      provider: fakeProvider,
      model: "openai/auto:codex-latest",
      input: { text },
    });
    expect(result.text).toContain("검색을 강제하지 않습니다");
  }

  expect(prompts).toHaveLength(5);
  for (const prompt of prompts) {
    expect(prompt).not.toContain("Freshness Evidence Repair");
    expect(prompt).not.toContain("Page Evidence Repair");
    expect(prompt).not.toContain("Freshness evidence required");
    expect(prompt).not.toContain("public_entity_or_local_business_lookup");
    expect(prompt).not.toContain("public_code_project_lookup");
  }
});

test("model-selected public evidence toolchain still receives structural citation handling", async () => {
  const executedTools: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      if (call.name === "web_search") {
        return {
          results: [{ title: "샘플 뉴스", url: "https://example.com/sample-news" }],
          source_urls: ["https://example.com/sample-news"],
        };
      }
      if (call.name === "web_read") {
        return {
          source_url: "https://example.com/sample-news",
          title: "샘플 뉴스",
          text: "본문 근거가 확인된 샘플 뉴스입니다.",
        };
      }
      throw new Error("unexpected tool " + call.name);
    },
    runFunctionToolPromptText: async (input) => {
      expect(input.prompt).not.toContain("Freshness evidence required");
      const toolNames = input.tools.map((tool) => tool.name);
      expect(toolNames).toContain("web_search");
      expect(toolNames).toContain("web_read");
      await input.executeTool({
        name: "web_search",
        args: { query: "오늘 샘플 뉴스" },
        rawArguments: "{\"query\":\"오늘 샘플 뉴스\"}",
      });
      await input.executeTool({
        name: "web_read",
        args: { url: "https://example.com/sample-news" },
        rawArguments: "{\"url\":\"https://example.com/sample-news\"}",
      });
      return "원문 본문 기준으로 핵심은 샘플 뉴스입니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "오늘 샘플 뉴스 기사 내용 핵심 알려줘" },
    metadata: {
      runtimePolicy: {
        completionReview: "disabled",
        requiredNativeTools: ["web_search", "web_read"],
      },
    },
  });

  expect(executedTools).toEqual(["web_search", "web_read"]);
  expect(result.text).toContain("원문 본문 기준");
  expect(result.text).toContain("Sources:");
  expect(result.text).toContain("https://example.com/sample-news");
});

test("native runtime does not duplicate existing web search sources", () => {
  const text = applyWebSearchCitationGuard({
    text: "Answer\n\n## Sources\n- [Docs](https://platform.openai.com/docs)",
    audit: [{
      name: "web_search",
      args: { query: "OpenAI docs" },
      ok: true,
      result: {
        source_urls: ["https://platform.openai.com/docs"],
      },
    }],
  });

  expect(text.match(/Sources/g)).toHaveLength(1);
});

test("native runtime does not apply user-action grounding guard to worker completion system events", async () => {
  const runtime = new NativeToolLoopRuntime({
    runFunctionToolPromptText: async () =>
      "워커 작업이 완료되었습니다. 결과 파일을 확인했고 사용자에게 보고할 수 있습니다.",
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "system:worker-complete:task-1",
      accountId: "default",
      transport: "system",
      peer: { kind: "dm", id: "user-1" },
      sender: {
        id: "butler-worker-monitor",
        displayName: "Butler Worker Monitor",
      },
      message: {
        id: "worker-complete:task-1",
        text: [
          "System event: a background worker task completed.",
          "Task ID: task-1",
          "Status: DONE",
          "Worker result: all green",
        ].join("\n"),
        timestamp: new Date().toISOString(),
      },
    },
  });

  expect(result.text).toContain("워커 작업이 완료되었습니다");
  expect(result.text).not.toContain("dispatch_worker");
  expect(result.text).not.toContain("이번 답변에서는 워커 실행을 확인하지 못했습니다");
});

test("native runtime records Butler tool call and result in transcript", async () => {
  const runtime = new NativeToolLoopRuntime({
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "list_tasks",
        args: { limit: 3 },
        rawArguments: "{\"limit\":3}",
      });
      return "작업 큐를 확인했습니다. 현재 작업은 없습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      text: "작업 큐 확인해줘",
    },
  });

  const transcript = readTranscript("butler/main");
  expect(transcript.some((event) => event.kind === "tool_call" && event.payload.name === "list_tasks")).toBe(true);
  expect(transcript.some((event) => event.kind === "tool_result" && event.payload.name === "list_tasks")).toBe(true);
});

test("native runtime unwraps tool_call through audited target dispatch", async () => {
  const events: RuntimeTurnEventInput[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    butlerHome: tempDir,
    butlerData: tempDir,
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "tool_call",
        args: { id: "native:get_context_monitor", arguments: {} },
        rawArguments: JSON.stringify({ id: "native:get_context_monitor", arguments: {} }),
      });
      return "컨텍스트 상태를 확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/progressive-tool-call-audit",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "컨텍스트 상태 확인해줘" },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
    emitTurnEvent: (event) => {
      events.push(event);
    },
  });

  const transcript = readTranscript("butler/main/progressive-tool-call-audit");
  expect(transcript.some((event) => event.kind === "tool_call" && event.payload.name === "get_context_monitor")).toBe(true);
  expect(transcript.some((event) => event.kind === "tool_result" && event.payload.name === "get_context_monitor")).toBe(true);
  expect(transcript.some((event) =>
    event.kind === "tool_call" &&
    event.payload.name === "tool_call" &&
    event.metadata?.tool_surface_transition === "invoke",
  )).toBe(true);
  expect(transcript.some((event) =>
    event.kind === "tool_result" &&
    event.payload.name === "tool_call" &&
    event.metadata?.tool_surface_transition === "invoked",
  )).toBe(true);
  const toolStarts = events.filter((event) => event.kind === "tool.started");
  expect(toolStarts.map((event) => event.payload?.toolName)).toEqual(
    expect.arrayContaining(["Tool Call", "Get Context Monitor"]),
  );
  expect(toolStarts.findIndex((event) => event.payload?.toolName === "Tool Call")).toBeLessThan(
    toolStarts.findIndex((event) => event.payload?.toolName === "Get Context Monitor"),
  );
});

test("native runtime records bridge audit metadata for bridged target failures", async () => {
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    butlerHome: tempDir,
    butlerData: tempDir,
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "tool_describe",
        args: { ids: ["native:web_search"] },
        rawArguments: JSON.stringify({ ids: ["native:web_search"] }),
      });
      await input.executeTool({
        name: "tool_call",
        args: { id: "native:web_search", arguments: { query: "x" } },
        rawArguments: JSON.stringify({ id: "native:web_search", arguments: { query: "x" } }),
      });
      return "검색 도구 실패를 복구 가능한 결과로 받았습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/progressive-tool-call-target-failure",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "짧은 검색 쿼리로 실패 경로를 확인해줘" },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  const transcript = readTranscript("butler/main/progressive-tool-call-target-failure");
  const result = transcript.find((event) => event.kind === "tool_result" && event.payload.name === "web_search");
  expect(result?.metadata?.bridge_audit).toEqual(expect.objectContaining({
    schema: "butler.bridge-tool-audit.v1",
    action: "invoke",
    tool_name: "tool_call",
    outcome: "error",
    target: expect.objectContaining({
      id: "native:web_search",
      provider: "native",
      affordance: "native_tool",
    }),
    result: { ok: false, code: "underlying_tool_error" },
    error: {
      code: "underlying_tool_error",
      recoverable: false,
      operational_failure: true,
    },
  }));
});

test("native runtime records bridge audit metadata for tool_call resolution failures", async () => {
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    butlerHome: tempDir,
    butlerData: tempDir,
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "tool_call",
        args: { id: "native:missing_tool", arguments: { token: "SECRET_TOKEN_123" } },
        rawArguments: JSON.stringify({ id: "native:missing_tool", arguments: { token: "SECRET_TOKEN_123" } }),
      });
      return "없는 도구 선택을 복구 가능한 결과로 받았습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/progressive-tool-call-resolution-failure",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "없는 도구를 호출했을 때 audit을 남겨줘" },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  const transcript = readTranscript("butler/main/progressive-tool-call-resolution-failure");
  const result = transcript.find((event) => event.kind === "tool_result" && event.payload.name === "tool_call");
  expect(result?.metadata?.bridge_audit).toEqual(expect.objectContaining({
    schema: "butler.bridge-tool-audit.v1",
    action: "invoke",
    tool_name: "tool_call",
    outcome: "unknown",
    request: {
      id: "native:missing_tool",
      arguments: "[redacted]",
    },
    result: { ok: false, code: "unknown_tool_catalog_id" },
    error: {
      code: "unknown_tool_catalog_id",
      recoverable: true,
      operational_failure: false,
    },
  }));
  expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN_123");
  expect(JSON.stringify(transcript)).not.toContain("SECRET_TOKEN_123");
  const call = transcript.find((event) => event.kind === "tool_call" && event.payload.name === "tool_call");
  expect(call?.payload.arguments).toMatchObject({
    schema_version: "butler.tool-call-arguments-transcript.v1",
    safe_arguments: {
      id: "native:missing_tool",
      arguments: {
        token: "[redacted]",
      },
    },
  });
});

test("native runtime closes bridge progress rows when tool_call resolution throws", async () => {
  const turnEvents: RuntimeTurnEventInput[] = [];
  let caughtMessage = "";
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    butlerHome: tempDir,
    butlerData: tempDir,
    executeButlerTool: async (call) => {
      if (call.name === "tool_call" && call.args.__bridge_resolve_only === true) {
        throw new Error("resolve exploded");
      }
      return { ok: true };
    },
    runFunctionToolPromptText: async (input) => {
      try {
        await input.executeTool({
          name: "tool_call",
          args: { id: "native:web_search", arguments: { query: "butler" } },
          rawArguments: JSON.stringify({ id: "native:web_search", arguments: { query: "butler" } }),
        });
      } catch (error) {
        caughtMessage = error instanceof Error ? error.message : String(error);
      }
      return "도구 호출 예외를 복구했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/progressive-tool-call-throwing-resolution",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "도구 호출 예외 진행 상태를 확인해줘" },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
    emitTurnEvent: (event) => {
      turnEvents.push(event);
    },
  });

  expect(caughtMessage).toBe("resolve exploded");
  const bridgeStarted = turnEvents.find((event) =>
    event.kind === "tool.started" && event.payload?.toolName === "Tool Call",
  );
  const bridgeFailed = turnEvents.find((event) =>
    event.kind === "tool.failed" && event.payload?.toolName === "Tool Call",
  );
  expect(bridgeStarted?.payload?.bridgePhase).toBe("invoke");
  expect(bridgeFailed?.payload?.bridgePhase).toBe("denied");
  const transcript = readTranscript("butler/main/progressive-tool-call-throwing-resolution");
  expect(transcript.some((event) =>
    event.kind === "tool_result" &&
    event.payload.name === "tool_call" &&
    event.payload.ok === false &&
    event.metadata?.tool_surface_transition === "denied",
  )).toBe(true);
});

test("native runtime records bridge audit metadata without raw search arguments", async () => {
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    butlerHome: tempDir,
    butlerData: tempDir,
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "tool_search",
        args: { provider: "native", query: "SECRET_TOKEN_123 web search" },
        rawArguments: JSON.stringify({ provider: "native", query: "SECRET_TOKEN_123 web search" }),
      });
      return "도구 목록을 확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/progressive-tool-search-audit",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "필요한 도구를 찾아줘" },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  const transcript = readTranscript("butler/main/progressive-tool-search-audit");
  const result = transcript.find((event) => event.kind === "tool_result" && event.payload.name === "tool_search");
  expect(result?.metadata?.bridge_audit).toEqual(expect.objectContaining({
    schema: "butler.bridge-tool-audit.v1",
    action: "search",
    tool_name: "tool_search",
    outcome: "ok",
    request: expect.objectContaining({
      provider: "native",
      query_present: true,
    }),
  }));
  expect(JSON.stringify(result?.metadata?.bridge_audit)).not.toContain("SECRET_TOKEN_123");
});

test("native runtime dispatches workers only through model-selected tool calls", async () => {
  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      executed.push({ name: call.name, args: call.args });
      return {
        ok: true,
        task_id: "task-123",
        status: "RUNNING",
      };
    },
    runFunctionToolPromptText: async (input) => {
      expect(input.prompt).not.toContain("## Runtime Actions Already Executed");
      if (input.prompt.includes("Final Result Contract Repair")) {
        return "작업을 시작했습니다. 완료되면 결과만 정리해 보고드리겠습니다.";
      }
      await input.executeTool({
        name: "dispatch_worker",
        args: { task: "worker test" },
        rawArguments: "{\"task\":\"worker test\"}",
      });
      return "워커 작업을 시작했습니다. task-123이 실행 중입니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      text: "워커 테스트 진행해줄래?",
    },
  });

  expect(executed).toHaveLength(1);
  expect(executed[0]!.name).toBe("dispatch_worker");
  expect(executed[0]!.args).toEqual({ task: "worker test" });
  expect(result.text).toBe("작업을 시작했습니다. 완료되면 결과만 정리해 보고드리겠습니다.");
  expect(result.text).not.toContain("task-123");

  const transcript = readTranscript("butler/main");
  expect(transcript.some((event) =>
    event.kind === "tool_call" &&
    event.payload.name === "dispatch_worker",
  )).toBe(true);
});

test("native runtime emits a user-facing execution plan before background dispatch", async () => {
  const deliveries: Array<{
    text: string;
    actionId: string;
    replyToMessageId?: string;
    metadata: Record<string, unknown>;
  }> = [];
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      expect(call.name).toBe("dispatch_worker");
      return {
        ok: true,
        task_id: "task-progress-123",
        status: "RUNNING",
      };
    },
    runFunctionToolPromptText: async (input) => {
      await input.onAssistantTextBeforeTools?.({
        text: "차트 생성은 시간이 걸릴 수 있으니 먼저 백그라운드에서 진행하겠습니다. 완료되면 결과와 확인한 내용을 짧게 정리해드리겠습니다.",
        toolCalls: [{
          name: "dispatch_worker",
          args: {
            task: [
              "Internal worker instruction: inspect /private/project in read-only mode.",
              "Cover installation/bootstrap, config discovery, Telegram polling, routing, session lifecycle, logs, tests, docs, and write result.md with six numbered sections.",
            ].join(" "),
          },
        }],
      });
      await input.executeTool({
        name: "dispatch_worker",
        args: {
          task: [
            "Internal worker instruction: inspect /private/project in read-only mode.",
            "Cover installation/bootstrap, config discovery, Telegram polling, routing, session lifecycle, logs, tests, docs, and write result.md with six numbered sections.",
          ].join(" "),
        },
        rawArguments: "{\"task\":\"Internal worker instruction\"}",
      });
      return "실행을 시작했습니다. 완료되면 생성 결과와 확인한 내용을 정리해 보고드리겠습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "telegram:1:main:50",
      accountId: "default",
      transport: "telegram",
      peer: { kind: "dm", id: "1" },
      sender: { id: "1" },
      message: {
        id: "50",
        text: "차트 만들어줘",
        timestamp: new Date().toISOString(),
      },
    },
    emitIntermediateDelivery: async (action) => {
      const text = action.message.text?.trim();
      if (!text) return;
      deliveries.push({
        text,
        actionId: action.actionId,
        replyToMessageId: action.message.replyToMessageId,
        metadata: action.metadata ?? {},
      });
    },
  });

  expect(result.text).toBe("실행을 시작했습니다. 완료되면 생성 결과와 확인한 내용을 정리해 보고드리겠습니다.");
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]!.text).toBe("차트 생성은 시간이 걸릴 수 있으니 먼저 백그라운드에서 진행하겠습니다. 완료되면 결과와 확인한 내용을 짧게 정리해드리겠습니다.");
  expect(deliveries[0]!.text).not.toContain("기준으로");
  expect(deliveries[0]!.replyToMessageId).toBe("50");
  expect(deliveries[0]!.text).not.toContain("task-progress-123");
  expect(deliveries[0]!.text).not.toContain("Internal worker instruction");
  expect(deliveries[0]!.text).not.toContain("Telegram polling");
  expect(deliveries[0]!.text).not.toContain("six numbered sections");
  expect(deliveries[0]!.text).not.toContain("워커");
  expect(deliveries[0]!.text).not.toContain("디스패치");
  expect(deliveries[0]!.metadata.tool).toBe("dispatch_worker");
  expect(deliveries[0]!.metadata.phase).toBe("before_tool_execution");
  expect(deliveries[0]!.metadata.kind).toBe("intermediate");
});

test("native runtime tolerates tool progress when no intermediate callback exists", async () => {
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    executeButlerTool: async () => ({ ok: true }),
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "bash",
        args: { command: "bun test" },
        rawArguments: "{\"command\":\"bun test\"}",
      });
      return "완료했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/no-progress-callback",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "telegram:1:main:no-progress-callback",
      accountId: "default",
      transport: "telegram",
      peer: { kind: "dm", id: "1" },
      sender: { id: "1" },
      message: {
        id: "no-progress-callback",
        text: "테스트 실행해줘",
        timestamp: new Date().toISOString(),
      },
    },
  });

  expect(result.text).toBe("완료했습니다.");
});

test("native runtime redacts complex tool progress command metadata", async () => {
  const progressActions: Array<Record<string, unknown>> = [];
  const privatePath = join(homedir(), "secret-project", "notes.txt");
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    executeButlerTool: async () => ({ ok: true }),
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "bash",
        args: {
          command: `cat ${privatePath} api_key=sk-test token=super-token password=hunter2`,
          nested: { secret: "nested-secret" },
        },
        rawArguments: JSON.stringify({
          command: `cat ${privatePath} api_key=sk-test token=super-token password=hunter2`,
          nested: { secret: "nested-secret" },
        }),
      });
      return "완료했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/tool-progress-redaction",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "telegram:1:main:tool-progress-redaction",
      accountId: "default",
      transport: "telegram",
      peer: { kind: "dm", id: "1" },
      sender: { id: "1" },
      message: {
        id: "tool-progress-redaction",
        text: "민감한 명령 실행 상태를 보여줘",
        timestamp: new Date().toISOString(),
      },
    },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
    emitIntermediateDelivery: async (action) => {
      if (action.metadata?.kind === "tool_progress") {
        progressActions.push(action.metadata);
      }
    },
  });

  const commandProgressActions = progressActions.filter((action) => action.activityKind === "ran_command");
  expect(commandProgressActions).toHaveLength(1);
  expect(commandProgressActions[0]).toMatchObject({
    activityKind: "ran_command",
    toolName: "Bash",
  });
  const serialized = JSON.stringify(commandProgressActions);
  expect(serialized).toContain("[redacted]");
  expect(serialized).not.toContain(homedir());
  expect(serialized).not.toContain("sk-test");
  expect(serialized).not.toContain("super-token");
  expect(serialized).not.toContain("hunter2");
  expect(serialized).not.toContain("nested-secret");
});

test("native runtime updates smart web search progress with planned queries", async () => {
  const progressActions: Array<Record<string, any>> = [];
  const turnEvents: Array<Record<string, any>> = [];
  const plannedQueries = [
    "젠레스 존 제로 현재 이벤트 2026년 5월 공식",
    "젠레스 존 제로 이벤트 2026년 5월 HoYoLAB",
    "Zenless Zone Zero current events May 2026 official",
    "Zenless Zone Zero events May 2026 Game8 Prydwen",
  ];
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    executeButlerTool: async () => ({
      query: "젠레스 존 제로 현재 진행중인 이벤트 2026 5월 22 공식 HoYoverse Zenless Zone Zero events",
      results: [],
      provider: "tracking",
      usage: { search_requests: plannedQueries.length },
      search_plan: {
        mode: "smart",
        depth: "verification",
        queries: plannedQueries.map((query) => ({ query })),
      },
    }),
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "web_search",
        args: {
          query: "젠레스 존 제로 현재 진행중인 이벤트 2026 5월 22 공식 HoYoverse Zenless Zone Zero events",
        },
        rawArguments: JSON.stringify({
          query: "젠레스 존 제로 현재 진행중인 이벤트 2026 5월 22 공식 HoYoverse Zenless Zone Zero events",
        }),
      });
      return "확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/smart-search-progress",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "app:smart-search-progress",
      accountId: "local",
      transport: "app",
      peer: { kind: "dm", id: "general" },
      sender: { id: "app-user" },
      message: {
        id: "smart-search-progress",
        text: "아참 그리고 지금 진행중인 젠레스존제로 이벤트들 확인좀 해줄래?",
        timestamp: new Date().toISOString(),
      },
    },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
    emitTurnEvent: (event) => {
      turnEvents.push(event as Record<string, any>);
    },
    emitIntermediateDelivery: async (action) => {
      if (action.metadata?.kind === "tool_progress") {
        progressActions.push(action.metadata as Record<string, any>);
      }
    },
  });

  const completedProgress = progressActions.at(-1);
  expect(completedProgress).toMatchObject({
    kind: "tool_progress",
    safeLabel: "Smart web search: 4 planned queries",
    inputLabel: "4 planned queries",
  });
  expect(
    completedProgress?.detailRows.map((row: { safe_value: string }) => row.safe_value),
  ).toEqual(plannedQueries);
  const completedTurnEvent = turnEvents.find((event) => event.kind === "tool.completed");
  expect(completedTurnEvent?.payload).toMatchObject({
    safeLabel: "Smart web search: 4 planned queries",
    inputLabel: "4 planned queries",
  });
  expect(
    completedTurnEvent?.payload.detailRows.map((row: { safe_value: string }) => row.safe_value),
  ).toEqual(plannedQueries);
});

test("native runtime keeps internal todo tools out of public toolchain events", async () => {
  const turnEvents: any[] = [];
  const progressActions: Array<Record<string, unknown>> = [];
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    executeButlerTool: async () => ({ ok: true, updated: true }),
    runFunctionToolPromptText: async (input) => {
      await input.onAssistantTextBeforeTools?.({
        text: "summary: 진행 단계를 정리합니다.\nrationale: 중형 작업의 현재 단계를 추적해야 합니다.\nnext_step: 수집 단계로 넘어갑니다.",
        toolCalls: [{
          name: "update_todo_list",
          args: {
            todos: [
              {
                id: "collect",
                content: "자료 수집하기",
                active_form: "자료 수집하기",
                status: "in_progress",
                phase: "execution",
              },
              {
                id: "chart",
                content: "그래프 그리기",
                active_form: "그래프 그리기",
                status: "pending",
                phase: "reporting",
              },
            ],
          },
        }],
      });
      await input.executeTool({
        name: "update_todo_list",
        args: {
          todos: [
            {
              id: "collect",
              content: "자료 수집하기",
              active_form: "자료 수집하기",
              status: "in_progress",
              phase: "execution",
            },
            {
              id: "chart",
              content: "그래프 그리기",
              active_form: "그래프 그리기",
              status: "pending",
              phase: "reporting",
            },
          ],
        },
        rawArguments: JSON.stringify({ todos: [] }),
      });
      return "진행 단계를 정리했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/todo-progress",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "mock:todo-progress",
      accountId: "default",
      transport: "mock",
      peer: { kind: "dm", id: "1" },
      sender: { id: "1" },
      message: {
        id: "todo-progress",
        text: "자료 수집과 그래프 작업 진행상황을 잡아줘",
        timestamp: new Date().toISOString(),
      },
    },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
    emitTurnEvent: (event) => {
      turnEvents.push(event);
    },
    emitIntermediateDelivery: async (action) => {
      if (action.metadata?.kind) progressActions.push(action.metadata);
    },
  });

  expect(turnEvents.some((event) =>
    (String(event.kind).startsWith("tool.") && event.payload?.activityKind !== "model") ||
    String(event.kind).startsWith("work.block"),
  )).toBe(false);
  expect(progressActions.some((action) =>
    action.kind === "tool_progress" && action.activityKind !== "model",
  )).toBe(false);
  expect(progressActions.filter((action) => action.kind === "todo_progress")).toEqual([
    expect.objectContaining({
      safeLabel: "자료 수집하기",
      state: "running",
      phase: "execution",
    }),
    expect.objectContaining({
      safeLabel: "그래프 그리기",
      state: "accepted",
      phase: "reporting",
    }),
  ]);
  expect(readTranscript("butler/main/todo-progress")
    .filter((event) => event.kind === "tool_call")
    .map((event) => event.payload.name)).toEqual(["update_todo_list"]);
});

test("native runtime groups chained tools under the active semantic todo work block", async () => {
  const turnEvents: any[] = [];
  const todos = [
    {
      id: "inspect",
      content: "프로젝트 메타정보와 구조 확인",
      active_form: "프로젝트 메타정보와 구조 확인 중",
      status: "in_progress",
      phase: "execution",
    },
  ];
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    executeButlerTool: async (call) => ({
      ok: true,
      tool: call.name,
    }),
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "update_todo_list",
        args: { todos },
        rawArguments: JSON.stringify({ todos }),
      });
      await input.executeTool({
        name: "run_command",
        args: { command: "pwd" },
        rawArguments: "{\"command\":\"pwd\"}",
      });
      await input.executeTool({
        name: "read_tool_output_artifact",
        args: { artifact_id: "artifact-1" },
        rawArguments: "{\"artifact_id\":\"artifact-1\"}",
      });
      return "확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/semantic-toolchain",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "현재 작업에 필요한 로컬 상태를 확인해줘." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
    emitTurnEvent: (event) => {
      turnEvents.push(event);
    },
  });

  const toolStarts = turnEvents.filter((event) => event.kind === "tool.started");
  expect(toolStarts).toHaveLength(2);
  expect(toolStarts.map((event) => event.payload.workBlockId)).toEqual([
    "work-todo-inspect",
    "work-todo-inspect",
  ]);
  expect(toolStarts.map((event) => event.payload.workBlockLabel)).toEqual([
    "프로젝트 메타정보와 구조 확인 중",
    "프로젝트 메타정보와 구조 확인 중",
  ]);
  expect(turnEvents.filter((event) => event.kind === "work.block.completed")).toHaveLength(0);
});

test("native runtime completes reporting WorkStream when final answer is delivered", async () => {
  const todos = [
    {
      id: "frame",
      content: "의도 파악하기",
      active_form: "의도 파악하기",
      status: "completed",
      phase: "conception",
    },
    {
      id: "plan",
      content: "확인 경로 정하기",
      active_form: "확인 경로 정하기",
      status: "completed",
      phase: "planning",
    },
    {
      id: "inspect",
      content: "로컬 상태 확인하기",
      active_form: "로컬 상태 확인하기",
      status: "completed",
      phase: "execution",
    },
    {
      id: "review",
      content: "확인 결과 검토하기",
      active_form: "확인 결과 검토하기",
      status: "completed",
      phase: "review",
    },
    {
      id: "consolidate",
      content: "결과 정리하기",
      active_form: "결과 정리하기",
      status: "completed",
      phase: "consolidation",
    },
    {
      id: "report",
      content: "짧게 보고하기",
      active_form: "짧게 보고하기",
      status: "in_progress",
      phase: "reporting",
    },
  ];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    butlerData: tempDir,
    butlerHome: tempDir,
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "update_todo_list",
        args: {
          title: "브랜치 및 스크립트 확인",
          todos,
        },
        rawArguments: JSON.stringify({ title: "브랜치 및 스크립트 확인", todos }),
      });
      return "확인 결과를 짧게 보고했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/reporting-complete",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "현재 브랜치와 WorkStream E2E 스크립트를 확인해줘." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(result.text).toContain("짧게 보고했습니다");
  const streams = new WorkStreamStore(tempDir).list({
    sessionId: "butler/main/reporting-complete",
    includeTerminal: true,
  });
  expect(streams).toHaveLength(1);
  expect(streams[0].state).toBe("complete");
  expect(streams[0].current_phase).toBeNull();
  expect(streams[0].active_step_id).toBeNull();
});

test("native runtime continues instead of delivering while direct todo work is unfinished", async () => {
  let promptCalls = 0;
  let continuationPrompt = "";
  const firstTodos = [
    {
      id: "find-files",
      content: "컴팩션 관련 파일을 찾기",
      active_form: "관련 파일 탐색 중",
      status: "in_progress",
      phase: "conception",
    },
    {
      id: "inspect",
      content: "핵심 로직 검토하기",
      active_form: "핵심 로직 검토 중",
      status: "pending",
      phase: "execution",
    },
    {
      id: "report",
      content: "근거와 함께 보고하기",
      active_form: "근거와 함께 보고 중",
      status: "pending",
      phase: "reporting",
    },
  ] as const;
  const finalTodos = [
    { ...firstTodos[0], status: "completed" as const },
    { ...firstTodos[1], status: "completed" as const },
    { ...firstTodos[2], status: "in_progress" as const },
  ];
  const defaultExecutor = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    workspacePath: tempDir,
    sessionId: "butler/main/open-direct-work-final-guard",
  });
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    butlerData: tempDir,
    butlerHome: tempDir,
    executeButlerTool: async (call) => {
      if (call.name === "run_command") {
        return {
          ok: true,
          evidence_receipts: [{
            schema: "butler.evidence-receipt.v1",
            id: "blank-receipt",
            producer: { kind: "tool", name: "run_command" },
            receiptType: "",
            verified: true,
            covers: [],
            summary: "",
          }],
        };
      }
      return await defaultExecutor(call);
    },
    runFunctionToolPromptText: async (input) => {
      promptCalls += 1;
      if (promptCalls === 1) {
        await input.executeTool({
          name: "update_todo_list",
          args: {
            title: "컨텍스트 컴팩션 설계 리뷰",
            todos: firstTodos,
          },
          rawArguments: JSON.stringify({ title: "컨텍스트 컴팩션 설계 리뷰", todos: firstTodos }),
        });
        await input.executeTool({
          name: "run_command",
          args: { command: "printf 'blank receipt fixture\\n'" },
          rawArguments: JSON.stringify({ command: "printf 'blank receipt fixture\\n'" }),
        });
        return "파일 탐색부터 시작하겠다냐.";
      }
      continuationPrompt = input.prompt;
      await input.executeTool({
        name: "run_command",
        args: {
          command: "printf 'packages/butler-agent/src/agent/context/budget.ts\\npackages/butler-agent/src/agent/context/compaction.ts\\n'",
        },
        rawArguments: JSON.stringify({
          command: "printf 'packages/butler-agent/src/agent/context/budget.ts\\npackages/butler-agent/src/agent/context/compaction.ts\\n'",
        }),
      });
      await input.executeTool({
        name: "update_todo_list",
        args: {
          title: "컨텍스트 컴팩션 설계 리뷰",
          todos: finalTodos,
        },
        rawArguments: JSON.stringify({ title: "컨텍스트 컴팩션 설계 리뷰", todos: finalTodos }),
      });
      return "검토 완료: 핵심 근거 파일은 packages/butler-agent/src/agent/context/budget.ts와 packages/butler-agent/src/agent/context/compaction.ts입니다냐.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/open-direct-work-final-guard",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "local/gemma-test",
    input: { text: "컨텍스트 컴팩션 설계에서 빠진 위험을 짧게 리뷰해줘." },
    metadata: {
      promptContext: [
        "## Active Persona Reminder",
        "",
        "Use this current persona for every user-facing answer in this turn.",
        "PERSONA_CONTINUATION_SENTINEL",
      ].join("\n"),
      runtimePolicy: { completionReview: "disabled" },
    },
  });

  expect(promptCalls).toBe(2);
  expect(continuationPrompt).toContain("Direct Work Continuation");
  expect(continuationPrompt).toContain("Persona continuation");
  expect(continuationPrompt).toContain("PERSONA_CONTINUATION_SENTINEL");
  expect(continuationPrompt).toContain("Remaining direct steps");
  expect(continuationPrompt).toContain("Continuity note");
  expect(continuationPrompt).toContain("evidence 1: update_todo_list");
  expect(continuationPrompt).toContain("evidence 2: run_command");
  expect(continuationPrompt).not.toContain("receipts: same user request");
  expect(continuationPrompt).not.toContain("Final Delivery Blocked");
  expect(continuationPrompt).not.toContain("previous answer is not deliverable");
  expect(continuationPrompt).not.toContain("Continue the original user request now");
  expect(continuationPrompt).not.toContain("Previous non-deliverable answer");
  expect(continuationPrompt).not.toContain("Original turn prompt");
  expect(continuationPrompt.toLowerCase()).not.toContain("restart");
  expect(continuationPrompt.toLowerCase()).not.toContain("interruption");
  expect(result.text).toContain("검토 완료");
  expect(result.text).not.toContain("시작하겠다");
  const toolCalls = readTranscript("butler/main/open-direct-work-final-guard")
    .filter((event) => event.kind === "tool_call")
    .map((event) => event.payload.name);
  expect(toolCalls).toEqual(["update_todo_list", "run_command", "run_command", "update_todo_list"]);
  const streams = new WorkStreamStore(tempDir).list({
    sessionId: "butler/main/open-direct-work-final-guard",
    includeTerminal: true,
  });
  expect(streams).toHaveLength(1);
  expect(streams[0].state).toBe("complete");
});

test("native runtime keeps extending direct work while continuations make tool progress", async () => {
  let promptCalls = 0;
  const continuationPrompts: string[] = [];
  const todoForStage = (stage: number) => [
    {
      id: "commit",
      content: "첫 변경분 검증 후 커밋",
      active_form: "첫 변경분 검증 후 커밋하는 중",
      status: stage >= 1 ? "completed" as const : "in_progress" as const,
      phase: "execution",
    },
    {
      id: "e2e",
      content: "클론된 Butler home/data e2e 검증",
      active_form: "클론된 Butler home/data e2e 검증 중",
      status: stage >= 2 ? "completed" as const : stage === 1 ? "in_progress" as const : "pending" as const,
      phase: "execution",
    },
    {
      id: "next-task",
      content: "다음 WATL 작업 구현 후 커밋",
      active_form: "다음 WATL 작업 구현 후 커밋하는 중",
      status: stage >= 3 ? "completed" as const : stage === 2 ? "in_progress" as const : "pending" as const,
      phase: "execution",
    },
  ];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    butlerData: tempDir,
    butlerHome: tempDir,
    runFunctionToolPromptText: async (input) => {
      promptCalls += 1;
      if (promptCalls === 1) {
        await input.executeTool({
          name: "update_todo_list",
          args: {
            title: "WATL 직접 구현",
            todos: todoForStage(0),
          },
          rawArguments: JSON.stringify({ title: "WATL 직접 구현", todos: todoForStage(0) }),
        });
        return "첫 변경분부터 진행하겠습니다.";
      }
      continuationPrompts.push(input.prompt);
      const stage = promptCalls - 1;
      await input.executeTool({
        name: "run_command",
        args: { command: `printf 'stage ${stage}\\n'` },
        rawArguments: JSON.stringify({ command: `printf 'stage ${stage}\\n'` }),
      });
      await input.executeTool({
        name: "update_todo_list",
        args: {
          title: "WATL 직접 구현",
          todos: todoForStage(stage),
        },
        rawArguments: JSON.stringify({ title: "WATL 직접 구현", todos: todoForStage(stage) }),
      });
      return stage >= 3
        ? "세 번째 continuation에서 남은 WATL 직접 작업까지 완료했습니다."
        : `stage ${stage} 작업만 완료했습니다.`;
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/open-direct-work-multi-continuation",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "local/gemma-test",
    input: { text: "WATL 작업을 순서대로 직접 처리하고 각 단계마다 커밋해줘." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(promptCalls).toBe(4);
  expect(continuationPrompts).toHaveLength(3);
  expect(continuationPrompts.every((prompt) => prompt.includes("Direct Work Continuation")))
    .toBe(true);
  expect(continuationPrompts.every((prompt) => !prompt.includes("Final Delivery Blocked")))
    .toBe(true);
  expect(continuationPrompts.every((prompt) => prompt.includes("todo_list_id: main")))
    .toBe(true);
  expect(result.text).toContain("세 번째 continuation");
  const toolCalls = readTranscript("butler/main/open-direct-work-multi-continuation")
    .filter((event) => event.kind === "tool_call")
    .map((event) => event.payload.name);
  expect(toolCalls).toEqual([
    "update_todo_list",
    "run_command",
    "update_todo_list",
    "run_command",
    "update_todo_list",
    "run_command",
    "update_todo_list",
  ]);
  const streams = new WorkStreamStore(tempDir).list({
    sessionId: "butler/main/open-direct-work-multi-continuation",
    includeTerminal: true,
  });
  expect(streams).toHaveLength(1);
  expect(streams[0].state).toBe("complete");
});

test("native runtime stops direct work continuation when tools do not make semantic progress", async () => {
  const originalLimit = process.env.BUTLER_DIRECT_WORK_CONTINUATION_ATTEMPTS;
  process.env.BUTLER_DIRECT_WORK_CONTINUATION_ATTEMPTS = "3";
  let promptCalls = 0;
  const executedCommands: string[] = [];
  try {
    const runtime = new NativeToolLoopRuntime({
      disableAutomaticRecall: true,
      messageLanguage: "ko",
      butlerData: tempDir,
      butlerHome: tempDir,
      runFunctionToolPromptText: async (input) => {
        promptCalls += 1;
        if (promptCalls === 1) {
          await input.executeTool({
            name: "update_todo_list",
            args: {
              title: "Issue #2 direct work",
              todos: [{
                id: "commit-write",
                content: "write_file 구현 검증 후 커밋",
                active_form: "write_file 구현 검증 후 커밋하는 중",
                status: "in_progress",
                phase: "execution",
              }],
            },
            rawArguments: JSON.stringify({
              title: "Issue #2 direct work",
              todos: [{
                id: "commit-write",
                content: "write_file 구현 검증 후 커밋",
                active_form: "write_file 구현 검증 후 커밋하는 중",
                status: "in_progress",
                phase: "execution",
              }],
            }),
          });
          return "write_file 커밋이 아직 남아 있습니다.";
        }
        expect(input.prompt).toContain("Direct Work Continuation");
        await input.executeTool({
          name: "run_command",
          args: { command: "git status --short" },
          rawArguments: JSON.stringify({ command: "git status --short" }),
        });
        executedCommands.push("git status --short");
        return "상태만 다시 확인했고 write_file 커밋은 아직 남아 있습니다.";
      },
    });
    const handle = await runtime.createSession({
      sessionId: "butler/main/open-direct-work-no-semantic-progress",
      role: "butler",
      workspacePath: tempDir,
      systemPrompt: "You are Butler.",
    });

    const result = await runtime.runTurn({
      handle,
      provider: fakeProvider,
      model: "local/gemma-test",
      input: { text: "Issue #2 작업을 직접 완료하고 task마다 커밋해줘." },
      metadata: { runtimePolicy: { completionReview: "disabled" } },
    });

    expect(result.text).toContain("아직 완료라고 보고할 수 있는 상태까지는 도달하지 못했습니다.");
    expect(promptCalls).toBe(2);
    expect(executedCommands).toEqual(["git status --short"]);
    const streams = new WorkStreamStore(tempDir).list({
      sessionId: "butler/main/open-direct-work-no-semantic-progress",
      includeTerminal: true,
    });
    expect(streams[0]!.state).toBe("recoverable");
  } finally {
    if (originalLimit === undefined) delete process.env.BUTLER_DIRECT_WORK_CONTINUATION_ATTEMPTS;
    else process.env.BUTLER_DIRECT_WORK_CONTINUATION_ATTEMPTS = originalLimit;
  }
});

test("native runtime accepts WorkStream FSM transitions as direct work semantic progress", async () => {
  const originalLimit = process.env.BUTLER_DIRECT_WORK_CONTINUATION_ATTEMPTS;
  process.env.BUTLER_DIRECT_WORK_CONTINUATION_ATTEMPTS = "3";
  let promptCalls = 0;
  try {
    const runtime = new NativeToolLoopRuntime({
      disableAutomaticRecall: true,
      messageLanguage: "ko",
      butlerData: tempDir,
      butlerHome: tempDir,
      runFunctionToolPromptText: async (input) => {
        promptCalls += 1;
        if (promptCalls === 1) {
          await input.executeTool({
            name: "update_todo_list",
            args: {
              title: "FSM direct work",
              todos: [{
                id: "execute",
                content: "구현 근거 확인",
                active_form: "구현 근거 확인 중",
                status: "in_progress",
                phase: "execution",
              }],
            },
            rawArguments: JSON.stringify({
              title: "FSM direct work",
              todos: [{
                id: "execute",
                content: "구현 근거 확인",
                active_form: "구현 근거 확인 중",
                status: "in_progress",
                phase: "execution",
              }],
            }),
          });
          return "구현 근거 확인이 아직 진행 중입니다.";
        }
        if (promptCalls === 2) {
          expect(input.prompt).toContain("Direct Work Continuation");
          await input.executeTool({
            name: "update_work_stream_state",
            args: {
              state: "reviewing",
              active_step_id: "review",
              status_note: "Execution evidence is ready for review.",
            },
            rawArguments: JSON.stringify({
              state: "reviewing",
              active_step_id: "review",
              status_note: "Execution evidence is ready for review.",
            }),
          });
          return "검토 단계로 전환했습니다. 보고 단계가 아직 남아 있습니다.";
        }
        expect(input.prompt).toContain("Direct Work Continuation");
        await input.executeTool({
          name: "update_todo_list",
          args: {
            title: "FSM direct work",
            todos: [
              {
                id: "execute",
                content: "구현 근거 확인",
                active_form: "구현 근거 확인 중",
                status: "completed",
                phase: "execution",
              },
              {
                id: "review",
                content: "검토 완료",
                active_form: "검토 완료 중",
                status: "completed",
                phase: "review",
              },
              {
                id: "report",
                content: "결과 보고",
                active_form: "결과 보고 중",
                status: "completed",
                phase: "reporting",
              },
            ],
          },
          rawArguments: JSON.stringify({
            title: "FSM direct work",
            todos: [
              {
                id: "execute",
                content: "구현 근거 확인",
                active_form: "구현 근거 확인 중",
                status: "completed",
                phase: "execution",
              },
              {
                id: "review",
                content: "검토 완료",
                active_form: "검토 완료 중",
                status: "completed",
                phase: "review",
              },
              {
                id: "report",
                content: "결과 보고",
                active_form: "결과 보고 중",
                status: "completed",
                phase: "reporting",
              },
            ],
          }),
        });
        return "FSM 전진과 보고까지 완료했습니다.";
      },
    });
    const handle = await runtime.createSession({
      sessionId: "butler/main/open-direct-work-fsm-progress",
      role: "butler",
      workspacePath: tempDir,
      systemPrompt: "You are Butler.",
    });

    const result = await runtime.runTurn({
      handle,
      provider: fakeProvider,
      model: "local/gemma-test",
      input: { text: "구현 근거를 확인하고 WorkStream 검토까지 직접 진행해줘." },
      metadata: { runtimePolicy: { completionReview: "disabled" } },
    });

    expect(result.text).toContain("FSM 전진");
    expect(promptCalls).toBe(3);
    const toolCalls = readTranscript("butler/main/open-direct-work-fsm-progress")
      .filter((event) => event.kind === "tool_call")
      .map((event) => event.payload.name);
    expect(toolCalls).toEqual([
      "update_todo_list",
      "update_work_stream_state",
      "update_todo_list",
    ]);
    const streams = new WorkStreamStore(tempDir).list({
      sessionId: "butler/main/open-direct-work-fsm-progress",
      includeTerminal: true,
    });
    expect(streams).toHaveLength(1);
    expect(streams[0].state).toBe("complete");
  } finally {
    if (originalLimit === undefined) delete process.env.BUTLER_DIRECT_WORK_CONTINUATION_ATTEMPTS;
    else process.env.BUTLER_DIRECT_WORK_CONTINUATION_ATTEMPTS = originalLimit;
  }
});

test("native runtime returns recoverable tool errors to the model instead of aborting the turn", async () => {
  let observedToolError: unknown;
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    butlerData: tempDir,
    butlerHome: tempDir,
    runFunctionToolPromptText: async (input) => {
      observedToolError = await input.executeTool({
        name: "update_todo_list",
        args: {
          todos: [{
            id: "bad",
            content: "Bad status",
            active_form: "Bad status",
            status: false,
            phase: "planning",
          }],
        },
        rawArguments: JSON.stringify({ todos: [{ status: false }] }),
      });
      await input.executeTool({
        name: "update_todo_list",
        args: {
          title: "Recovered todo",
          todos: [{
            id: "report",
            content: "Report recovered result",
            active_form: "Reporting recovered result",
            status: "in_progress",
            phase: "reporting",
          }],
        },
        rawArguments: JSON.stringify({ title: "Recovered todo" }),
      });
      return "잘못된 도구 입력을 수정하고 복구했습니다냐.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/recoverable-tool-error",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "local/gemma-test",
    input: { text: "작업 상태를 정리해줘." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(observedToolError).toMatchObject({
    ok: false,
    error: expect.stringContaining("todo status"),
  });
  expect(result.text).toContain("복구했습니다");
  const transcript = readTranscript("butler/main/recoverable-tool-error");
  expect(transcript.some((event) =>
    event.kind === "tool_result" &&
    event.payload.name === "update_todo_list" &&
    event.payload.ok === false)).toBe(true);
});

test("native runtime does not emit turn failed before recoverable limited delivery", async () => {
  const events: Array<{ kind: string }> = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    butlerData: tempDir,
    butlerHome: tempDir,
    runFunctionToolPromptText: async () => {
      const error = new Error("missing evidence receipt for source_verified");
      error.name = "GoalCompletionIncompleteError";
      throw error;
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/recoverable-limited-boundary",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await expect(runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "local/gemma-test",
    input: {
      text: "근거가 부족하면 오류 대신 제한 포함 결과로 정리해줘.",
    },
    emitTurnEvent: (event) => {
      events.push({ kind: event.kind });
    },
    metadata: { runtimePolicy: { completionReview: "enabled" } },
  })).rejects.toThrow("missing evidence");

  expect(events.some((event) => event.kind === "turn.failed")).toBe(false);
});

test("native runtime marks interrupted direct WorkStreams recoverable", async () => {
  const sessionId = "butler/main/interrupted-direct-work";
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    butlerData: tempDir,
    butlerHome: tempDir,
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "update_todo_list",
        args: {
          title: "긴 작업 내구성 확인",
          todos: [{
            id: "inspect",
            content: "긴 작업 상태 확인",
            active_form: "긴 작업 상태 확인 중",
            status: "in_progress",
            phase: "execution",
          }, {
            id: "report",
            content: "복구 가능한 상태 보고",
            active_form: "복구 가능한 상태 보고 중",
            status: "pending",
            phase: "reporting",
          }],
        },
        rawArguments: JSON.stringify({ title: "긴 작업 내구성 확인" }),
      });
      throw new Error("The socket connection was closed unexpectedly.");
    },
  });
  const handle = await runtime.createSession({
    sessionId,
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await expect(runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "local/gemma-test",
    input: { text: "이 작업은 오래 걸려도 계속되어야 해." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  })).rejects.toThrow("socket connection");

  const streams = new WorkStreamStore(tempDir).list({ sessionId, includeTerminal: true });
  expect(streams).toHaveLength(1);
  expect(streams[0]).toMatchObject({
    state: "recoverable",
    current_phase: "execution",
    active_step_id: "inspect",
    terminal: false,
  });
  const record = new WorkStreamStore(tempDir).read(streams[0].id);
  expect(record?.status_note).toContain("interrupted before final delivery");
  expect(new TodoListStore(tempDir).view(record!.todo_list_id!, { includeCompleted: true }).progress.active)
    .toBe(0);
});

test("native runtime synthesizes durable WorkStream progress when a compound tool turn skips todo setup", async () => {
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    butlerData: tempDir,
    butlerHome: tempDir,
    runFunctionToolPromptText: async (input) => {
      const command = "printf 'main\\napp:client:workstream:natural-live-llm:e2e\\n' && true";
      await input.onAssistantTextBeforeTools?.({
        text: "summary: 현재 브랜치와 WorkStream E2E 스크립트를 확인합니다.\nrationale: 요청한 런타임 상태를 근거로 답해야 합니다.\nnext_step: 명령 결과를 검토해 보고합니다.",
        toolCalls: [{
          name: "run_command",
          args: { command },
        }],
      });
      await input.executeTool({
        name: "run_command",
        args: { command },
        rawArguments: JSON.stringify({ command }),
      });
      return "현재 브랜치는 main이고 WorkStream E2E 스크립트가 있습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/runtime-semantic-safety-net",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "local/gemma-test",
    input: { text: "현재 브랜치와 WorkStream E2E 스크립트를 확인해줘." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  const toolCalls = readTranscript("butler/main/runtime-semantic-safety-net")
    .filter((event) => event.kind === "tool_call")
    .map((event) => event.payload.name);
  expect(toolCalls).toContain("update_todo_list");
  expect(toolCalls).toContain("run_command");
  const streams = new WorkStreamStore(tempDir).list({
    sessionId: "butler/main/runtime-semantic-safety-net",
    includeTerminal: true,
  });
  expect(streams).toHaveLength(1);
  expect(streams[0].state).toBe("complete");
});

test("native runtime does not infer compound work from natural-language conjunctions", async () => {
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    butlerData: tempDir,
    butlerHome: tempDir,
    runFunctionToolPromptText: async (input) => {
      const command = "pwd";
      await input.onAssistantTextBeforeTools?.({
        text: "summary: 현재 위치를 확인합니다.\nrationale: 사용자가 실행 근거를 원했습니다.\nnext_step: 명령 결과를 보고합니다.",
        toolCalls: [{
          name: "run_command",
          args: { command },
        }],
      });
      await input.executeTool({
        name: "run_command",
        args: { command },
        rawArguments: JSON.stringify({ command }),
      });
      return "현재 위치를 확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/no-natural-language-semantic-safety-net",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "local/gemma-test",
    input: { text: "현재 위치 그리고 상태도 확인해줘, and keep it brief." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  const toolCalls = readTranscript("butler/main/no-natural-language-semantic-safety-net")
    .filter((event) => event.kind === "tool_call")
    .map((event) => event.payload.name);
  expect(toolCalls).toEqual(["run_command"]);
});

test("native runtime emits semantic progress from public decisions when todo setup is skipped", async () => {
  const progressActions: Array<Record<string, unknown>> = [];
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    executeButlerTool: async () => ({
      results: [{ title: "인구 통계", url: "https://example.test/population" }],
    }),
    runFunctionToolPromptText: async (input) => {
      await input.onAssistantTextBeforeTools?.({
        text: "summary: 2025년 인구 통계 후보 출처를 검색합니다.\nrationale: CSV와 차트에 넣을 공개 근거가 필요합니다.\nnext_step: 신뢰할 수 있는 후보를 읽어 수치를 확인합니다.",
        toolCalls: [{
          name: "web_search",
          args: { query: "2025 한국 도시 인구 통계" },
        }],
      });
      await input.executeTool({
        name: "web_search",
        args: { query: "2025 한국 도시 인구 통계" },
        rawArguments: JSON.stringify({ query: "2025 한국 도시 인구 통계" }),
      });
      return "검색 후보를 확인했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/decision-progress",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "mock:decision-progress",
      accountId: "default",
      transport: "mock",
      peer: { kind: "dm", id: "1" },
      sender: { id: "1" },
      message: {
        id: "decision-progress",
        text: "인구 통계 후보를 검색해줘",
        timestamp: new Date().toISOString(),
      },
    },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
    emitIntermediateDelivery: async (action) => {
      if (action.metadata?.kind === "todo_progress") progressActions.push(action.metadata);
    },
  });

  expect(progressActions).toEqual([
    expect.objectContaining({
      kind: "todo_progress",
      safeLabel: "2025년 인구 통계 후보 출처를 검색합니다.",
      state: "running",
    }),
    expect.objectContaining({
      kind: "todo_progress",
      safeLabel: "2025년 인구 통계 후보 출처를 검색합니다.",
      state: "delivered",
    }),
  ]);
});

test("native runtime omits model-authored execution plans that leak internal instructions", async () => {
  const deliveries: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    executeButlerTool: async () => ({
      ok: true,
      task_id: "task-long-user-subject",
      status: "RUNNING",
    }),
    runFunctionToolPromptText: async (input) => {
      await input.onAssistantTextBeforeTools?.({
        text: "Detailed internal execution spec that should remain hidden from transport output.",
        toolCalls: [{
          name: "dispatch_worker",
          args: { task: "Detailed internal execution spec that should remain hidden from transport output." },
        }],
      });
      await input.executeTool({
        name: "dispatch_worker",
        args: { task: "Detailed internal execution spec that should remain hidden from transport output." },
        rawArguments: "{\"task\":\"Detailed internal execution spec\"}",
      });
      return "점검을 시작했습니다. 완료되면 핵심만 정리해드리겠습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "telegram:1:main:51",
      accountId: "default",
      transport: "telegram",
      peer: { kind: "dm", id: "1" },
      sender: { id: "1" },
      message: {
        id: "51",
        text: "처음 설치한 사용자가 텔레그램으로 말을 걸었을 때 어디서 막힐 수 있는지 한번 점검해줘. 추가로 너무 긴 설명은 하지 말고 핵심만 알려줘.",
        timestamp: new Date().toISOString(),
      },
    },
    emitIntermediateDelivery: async (action) => {
      const text = action.message.text?.trim();
      if (text) deliveries.push(text);
    },
  });

  expect(deliveries).toHaveLength(0);
});

test("native runtime asks the model to write retry execution plans", async () => {
  const runRetryTurn = async (messageText: string): Promise<string> => {
    const deliveries: string[] = [];
    const runtime = new NativeToolLoopRuntime({
      messageLanguage: "ko",
      executeButlerTool: async () => ({
        ok: true,
        task_id: "task-retry-plan",
        status: "RUNNING",
      }),
      runFunctionToolPromptText: async (input) => {
        await input.onAssistantTextBeforeTools?.({
          text: `모델 작성 계획: ${messageText} 요청은 이전 작업을 같은 의도로 이어서 다시 확인하겠습니다.`,
          toolCalls: [{
            name: "dispatch_worker",
            args: { task: "Retry the previous first-run Telegram DM investigation with the same scope." },
          }],
        });
        await input.executeTool({
          name: "dispatch_worker",
          args: { task: "Retry the previous first-run Telegram DM investigation with the same scope." },
          rawArguments: "{\"task\":\"Retry previous work\"}",
        });
        return "같은 범위로 다시 시작했습니다. 완료되면 핵심만 정리해드리겠습니다.";
      },
    });
    const handle = await runtime.createSession({
      sessionId: `butler/main/${messageText}`,
      role: "butler",
      workspacePath: tempDir,
      systemPrompt: "You are Butler.",
    });

    await runtime.runTurn({
      handle,
      provider: fakeProvider,
      model: "openai/auto:codex-latest",
      input: {
        eventId: `telegram:1:main:${messageText}`,
        accountId: "default",
        transport: "telegram",
        peer: { kind: "dm", id: "1" },
        sender: { id: "1" },
        message: {
          id: messageText,
          text: messageText,
          timestamp: new Date().toISOString(),
        },
      },
      emitIntermediateDelivery: async (action) => {
        const text = action.message.text?.trim();
        if (text) deliveries.push(text);
      },
    });

    expect(deliveries).toHaveLength(1);
    return deliveries[0]!;
  };

  const retryMessages = [
    "다시 시도해봐",
    "다시 한번 시도해봐",
    "다시 한 번 시도해봐",
    "한번 더 해봐",
  ];

  for (const message of retryMessages) {
    const delivery = await runRetryTurn(message);
    expect(delivery).toContain(`모델 작성 계획: ${message}`);
    expect(delivery).not.toContain(`${message} 기준`);
    expect(delivery).not.toContain("기준으로");
    expect(delivery).not.toContain("Retry the previous");
  }
});

test("native runtime asks the model to write English retry execution plans", async () => {
  const deliveries: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "en",
    executeButlerTool: async () => ({
      ok: true,
      task_id: "task-retry-plan-en",
      status: "RUNNING",
    }),
    runFunctionToolPromptText: async (input) => {
      await input.onAssistantTextBeforeTools?.({
        text: "I will retry the previous work without repeating the internal instructions.",
        toolCalls: [{
          name: "dispatch_worker",
          args: { task: "Retry the previous first-run Telegram DM investigation with the same scope." },
        }],
      });
      await input.executeTool({
        name: "dispatch_worker",
        args: { task: "Retry the previous first-run Telegram DM investigation with the same scope." },
        rawArguments: "{\"task\":\"Retry previous work\"}",
      });
      return "I restarted the previous work.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/en-retry",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "telegram:1:main:52",
      accountId: "default",
      transport: "telegram",
      peer: { kind: "dm", id: "1" },
      sender: { id: "1" },
      message: {
        id: "en-retry",
        text: "try again",
        timestamp: new Date().toISOString(),
      },
    },
    emitIntermediateDelivery: async (action) => {
      const text = action.message.text?.trim();
      if (text) deliveries.push(text);
    },
  });

  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]).toContain("I will retry the previous work");
  expect(deliveries[0]).toContain("without repeating the internal instructions");
  expect(deliveries[0]).not.toContain("Retry the previous");
});

test("native runtime preserves persona-authored post-dispatch heartbeat", async () => {
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    executeButlerTool: async () => ({
      ok: true,
      task_id: "task-heartbeat",
      status: "RUNNING",
    }),
    runFunctionToolPromptText: async (input) => {
      await input.onAssistantTextBeforeTools?.({
        text: "Telegram DM 경로를 좁게 점검하겠습니다. 완료되면 해결 여부와 남은 위험만 정리해드리겠습니다.",
        toolCalls: [{
          name: "dispatch_worker",
          args: { task: "Inspect Telegram DM path." },
        }],
      });
      await input.executeTool({
        name: "dispatch_worker",
        args: { task: "Inspect Telegram DM path." },
        rawArguments: "{\"task\":\"Inspect Telegram DM path.\"}",
      });
      return "실행을 시작했습니다. 완료되면 이어서 확인하겠습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/heartbeat",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "telegram:1:main:heartbeat",
      accountId: "default",
      transport: "telegram",
      peer: { kind: "dm", id: "1" },
      sender: { id: "1" },
      message: {
        id: "heartbeat",
        text: "문제를 해결해봤어. 다시 시도해볼래?",
        timestamp: new Date().toISOString(),
      },
    },
  });

  expect(result.text).toBe("실행을 시작했습니다. 완료되면 이어서 확인하겠습니다.");
  expect(result.text).not.toContain("Telegram DM 최초 수신");
  expect(result.text).not.toContain("해결됨 / 일부 해결");
});

test("native runtime preserves persona-authored post-planned-dispatch heartbeat", async () => {
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    executeButlerTool: async (call) => ({
      ok: true,
      task_id: "planned-heartbeat",
      worker_task_id: call.name === "run_planned_task" ? "worker-planned-heartbeat" : undefined,
      attempt: 1,
      status: "PLANNED_RUNNING",
    }),
    runFunctionToolPromptText: async (input) => {
      await input.onAssistantTextBeforeTools?.({
        text: "먼저 기준을 세우고 검증 가능한 방식으로 진행하겠습니다. 완료되면 핵심 결과만 보고드리겠습니다.",
        toolCalls: [{
          name: "run_planned_task",
          args: { task_id: "planned-heartbeat" },
        }],
      });
      await input.executeTool({
        name: "run_planned_task",
        args: { task_id: "planned-heartbeat" },
        rawArguments: "{\"task_id\":\"planned-heartbeat\"}",
      });
      return "시작했습니다. 완료되면 핵심만 정리해 보고드리겠습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/planned-heartbeat",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      text: "프로젝트 구조를 조사해서 정리해줘",
    },
  });

  expect(result.text).toBe("시작했습니다. 완료되면 핵심만 정리해 보고드리겠습니다.");
  expect(result.text).not.toContain("주요 디렉터리");
  expect(result.text).not.toContain("worker/task queue");
});

test("native runtime localizes execution-plan messages in English", async () => {
  const deliveries: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "en",
    executeButlerTool: async () => ({
      ok: true,
      task_id: "task-progress-en",
      status: "RUNNING",
    }),
    runFunctionToolPromptText: async (input) => {
      await input.onAssistantTextBeforeTools?.({
        text: "I will start this in the background and report the useful result when it finishes.",
        toolCalls: [{
          name: "dispatch_worker",
          args: { task: "chart render" },
        }],
      });
      await input.executeTool({
        name: "dispatch_worker",
        args: { task: "chart render" },
        rawArguments: "{\"task\":\"chart render\"}",
      });
      return "Execution has started.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "mock:en:1",
      accountId: "default",
      transport: "mock",
      peer: { kind: "dm", id: "1" },
      sender: { id: "1" },
      message: {
        id: "en-1",
        text: "Please dispatch this worker.",
        timestamp: new Date().toISOString(),
      },
    },
    emitIntermediateDelivery: async (action) => {
      const text = action.message.text?.trim();
      if (text) deliveries.push(text);
    },
  });

  expect(deliveries[0]).toContain("I will start this in the background");
  expect(deliveries.join("\n")).not.toContain("worker");
  expect(deliveries.join("\n")).not.toContain("dispatch");
});

test("native runtime persists task origin context when dispatch_worker succeeds", async () => {
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: "butler/main",
    kind: "inbound",
    eventId: "event-before-origin",
    payload: {
      eventId: "mock:before",
      message: { text: "A 주제 차트 이야기" },
    },
  }));
  const runtime = new NativeToolLoopRuntime({
    butlerData: tempDir,
    executeButlerTool: async () => ({
      ok: true,
      task_id: "task-origin-123",
      status: "RUNNING",
    }),
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "dispatch_worker",
        args: {
          task: "A 주제 차트를 생성하고 결과를 요약",
          project_path: "fixtures/butler-project",
        },
        rawArguments: "{\"task\":\"A 주제 차트를 생성하고 결과를 요약\",\"project_path\":\"fixtures/butler-project\"}",
      });
      return "워커를 시작했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "mock:origin",
      accountId: "default",
      transport: "mock",
      peer: { kind: "dm", id: "user-1" },
      sender: { id: "user-1" },
      message: {
        id: "origin",
        text: "이 차트 작업은 워커로 보내줘",
        timestamp: new Date().toISOString(),
      },
    },
  });

  const originPath = join(tempDir, "tasks", "task-origin-123", "origin.json");
  expect(existsSync(originPath)).toBe(true);
  const origin = JSON.parse(readFileSync(originPath, "utf8"));
  expect(origin).toMatchObject({
    version: 1,
    origin_session_id: "butler/main",
    origin_message_id: "origin",
    origin_inbound_event_id: "mock:origin",
    task_summary: "A 주제 차트를 생성하고 결과를 요약",
    project: "fixtures/butler-project",
  });
  expect(origin.transcript_ref.path).toContain("butler_main.jsonl");
  expect(origin.transcript_ref.recent_event_ids).toContain("event-before-origin");
  expect(origin.transcript_ref.recent_event_ids).toContain("mock:origin");
});

test("native runtime inspects tasks only through model-selected tool calls", async () => {
  const executed: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    executeButlerTool: async (call) => {
      executed.push(call.name);
      return {
        ok: true,
        tasks: [],
      };
    },
    runFunctionToolPromptText: async (input) => {
      expect(input.prompt).not.toContain("## Runtime Actions Already Executed");
      await input.executeTool({
        name: "list_tasks",
        args: { limit: 10 },
        rawArguments: "{\"limit\":10}",
      });
      return "작업 큐를 확인했습니다. 현재 작업은 없습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      text: "테스트 워커 보낸건 어떻게됐어?",
    },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(executed).toEqual(["list_tasks"]);
  expect(result.text).toContain("작업 큐를 확인했습니다");
});
