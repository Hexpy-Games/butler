import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { createEvidenceCapabilityReceipt } from "../../packages/butler-agent/src/agent/output/evidence/parser.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import type { RuntimeTurnEventInput } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { operationalMetricsPath } from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import { WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";
import {
  createTurnContextAtomId,
  isTurnSchedulerContinuationYieldError,
  readTurnContextAtom,
} from "../../packages/butler-agent/src/agent/turn/turn-continuation-context.ts";
import { promptUsageModelCallBudgetExhaustedError } from "../../packages/butler-agent/src/integrations/providers/shared/usage.ts";
import { ModelProviderRequestError } from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import { cancelPersistedRuntimeTurn } from "../../packages/butler-agent/src/agent/turn/principal-turn-cancellation.ts";
import { registerPrincipalTurnAbortController } from "../../packages/butler-agent/src/agent/turn/principal-turn-cancellation-registry.ts";
import { WORKSPACE_INSPECTION_MAX_CONSECUTIVE_READS } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/obligation-tool-surface.ts";

let data = "";

beforeEach(() => {
  data = join(tmpdir(), `butler-typed-runtime-${Date.now()}-${Math.random()}`);
  mkdirSync(data, { recursive: true });
});

afterEach(() => rmSync(data, { recursive: true, force: true }));

const typedProvider: ModelProviderAdapter = {
  id: "typed-provider",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: true,
    supportsStructuredOutputs: true,
    structuredDecisionTransport: "json_schema",
  },
  async invoke() {
    return { text: "unused" };
  },
};

test("typed first productive pass returns a direct answer without entering the tool loop", async () => {
  const calls: Array<{ prompt: string; responseFormat?: unknown }> = [];
  const events: RuntimeTurnEventInput[] = [];
  let toolLoopCalls = 0;
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => {
      calls.push({ prompt: input.prompt, responseFormat: input.responseFormat });
      return JSON.stringify({
        schema_version: "butler.turn-contract-decision.v1",
        decision_id: decisionIdFromFormat(input.responseFormat),
        action: "answer",
        target_workstream_id: null,
        target_project_id: null,
        blocker_id: null,
        deliverables: [],
        answer_text: "바로 답할 수 있는 질문입니다.",
        public_summary: "현재 대화 맥락만으로 답할 수 있습니다.",
        immediate_next_step: null,
      });
    },
    runFunctionToolPromptText: async () => {
      toolLoopCalls += 1;
      return "unexpected";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/typed-direct",
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy. Answer in Korean.",
  });
  const result = await runtime.runTurn({
    handle,
    provider: typedProvider,
    model: "openai/gpt-5.5" as const,
    input: { text: "방금 말한 설계가 어떤 의미야?" },
    metadata: { thinFirstResponse: "app_default", runtimePolicy: { completionReview: "disabled" } },
    emitTurnEvent: (event) => {
      events.push(event);
    },
  });
  expect(result.text).toBe("바로 답할 수 있는 질문입니다.");
  expect(toolLoopCalls).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.responseFormat).toMatchObject({ type: "json_schema", strict: true });
  expect(calls[0]?.prompt).toContain("Active Persona Reminder");
  expect(events.some((event) => event.kind === "assistant.decision")).toBe(false);
  expect(readOnlyContract()).toMatchObject({ action: "answer", state: "delivered" });
  const processMetrics = readFileSync(operationalMetricsPath(data), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { category?: string; name?: string })
    .filter((event) => event.category === "process")
    .map((event) => event.name);
  expect(processMetrics).toEqual(expect.arrayContaining([
    "turn_cpu_ratio",
    "turn_memory_rss",
    "turn_memory_heap_used",
  ]));
});

test("function-tool providers submit the private typed decision without public tool execution", async () => {
  const events: RuntimeTurnEventInput[] = [];
  let decisionToolCalls = 0;
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async () => {
      throw new Error("json_schema_path_must_not_run");
    },
    runFunctionToolPromptText: async (input) => {
      decisionToolCalls += 1;
      expect(input.tools.map((tool) => tool.name)).toEqual(["submit_turn_decision"]);
      expect(input.maxToolRounds).toBe(2);
      expect(input.toolChoice).toBe("required");
      expect(input.onAssistantTextBeforeTools).toBeUndefined();
      expect(input.onProviderStreamEvent).toBeUndefined();
      const decisionId = (((input.tools[0]?.parameters as {
        properties?: { decision_id?: { const?: string } };
      }).properties?.decision_id?.const) ?? "");
      const args = {
        schema_version: "butler.turn-contract-decision.v1",
        decision_id: decisionId,
        action: "answer",
        target_workstream_id: null,
        target_project_id: null,
        blocker_id: null,
        deliverables: [],
        answer_text: "함수 호출로 제출된 직접 답변입니다.",
        public_summary: "현재 맥락만으로 바로 답할 수 있습니다.",
        immediate_next_step: null,
      };
      const output = await input.executeTool({
        name: "submit_turn_decision",
        args,
        rawArguments: JSON.stringify(args),
      });
      return await input.finalTextFromToolResult?.({
        name: "submit_turn_decision",
        args,
        output,
      }) ?? "";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/typed-function-decision",
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy. Answer in Korean.",
  });
  const result = await runtime.runTurn({
    handle,
    provider: {
      ...typedProvider,
      capabilities: {
        ...typedProvider.capabilities,
        structuredDecisionTransport: "function_tool",
      },
    },
    model: "zai/glm-5.2",
    input: { text: "방금 설계를 짧게 설명해줘." },
    metadata: { thinFirstResponse: "app_default", runtimePolicy: { completionReview: "disabled" } },
    emitTurnEvent: (event) => {
      events.push(event);
    },
  });

  expect(result.text).toBe("함수 호출로 제출된 직접 답변입니다.");
  expect(decisionToolCalls).toBe(1);
  expect(events.some((event) => event.kind === "assistant.decision")).toBe(false);
  expect(events.some((event) => event.kind === "tool.started")).toBe(false);
  expect(readOnlyContract()).toMatchObject({ action: "answer", state: "delivered" });
});

test("typed inspect contract exposes read tools and completes from a status receipt", async () => {
  let selectedTools: string[] = [];
  const events: RuntimeTurnEventInput[] = [];
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => JSON.stringify({
      schema_version: "butler.turn-contract-decision.v1",
      decision_id: decisionIdFromFormat(input.responseFormat),
      action: "inspect",
      target_workstream_id: null,
      target_project_id: "butler",
      blocker_id: null,
      evidence_domain: null,
      inspection_scope: "project",
      deliverables: ["status_report"],
      answer_text: null,
      public_summary: "현재 프로젝트 상태를 확인해야 정확히 답할 수 있습니다.",
      immediate_next_step: "Project Ledger 상태를 먼저 조회합니다.",
    }),
    runFunctionToolPromptText: async (input) => {
      selectedTools = workBlockCatalogNames(input.tools);
      expect(input.maxToolRounds).toBeGreaterThan(1);
      await input.executeTool({ name: "project_ledger_status", args: {}, rawArguments: "{}" });
      return "현재 프로젝트 상태는 정상이며 미해결 Ledger 오류가 없습니다.";
    },
    executeButlerTool: async () => ({
      ok: true,
      evidence_capability_receipts: [createEvidenceCapabilityReceipt({
        producer: { kind: "project_ledger", name: "project-ledger-status" },
        capability: "source_verified",
        evidence_kind: "project_state",
        summary: "Canonical project status was verified.",
      })],
    }),
  });
  const handle = await runtime.createSession({
    sessionId: "butler/typed-inspect",
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy. Answer in Korean.",
    metadata: { projectId: "butler" },
  });
  const result = await runtime.runTurn({
    handle,
    provider: typedProvider,
    model: "openai/gpt-5.5",
    input: { text: "지금 프로젝트 상태만 알려줘." },
    metadata: { thinFirstResponse: "app_default", runtimePolicy: { completionReview: "disabled" } },
    emitTurnEvent: (event) => {
      events.push(event);
    },
  });
  expect(result.text).toContain("정상");
  expect(selectedTools.sort()).toEqual([
    "inspect_project_status",
    "project_ledger_check",
    "project_ledger_list",
    "project_ledger_show",
    "project_ledger_status",
    "query_project_work",
    "render_project_dashboard",
  ].sort());
  const opening = events.find((event) => event.kind === "assistant.decision");
  expect(opening?.payload).toMatchObject({
    role: "opening",
    source: "model-authored",
    firstVisible: true,
    workstreamId: undefined,
  });
  expect((opening?.payload as Record<string, unknown>).contractId).toBeString();
  expect((opening?.payload as Record<string, unknown>).semanticBlockId).toBeString();
  expect(readOnlyContract()).toMatchObject({
    action: "inspect",
    tracking_mode: "ledger",
    closeout_strategy: "noop",
    state: "delivered",
  });
});

test("an invalid work-block decision returns feedback without executing its selected calls", async () => {
  const events: RuntimeTurnEventInput[] = [];
  const executedTools: string[] = [];
  let mainLoopCalls = 0;
  let invalidResult: unknown;
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => JSON.stringify({
      schema_version: "butler.turn-contract-decision.v1",
      decision_id: decisionIdFromFormat(input.responseFormat),
      action: "inspect",
      target_workstream_id: null,
      target_project_id: "butler",
      blocker_id: null,
      evidence_domain: null,
      inspection_scope: "project",
      deliverables: ["status_report"],
      answer_text: null,
      public_title: "프로젝트 상태 확인",
      public_summary: "현재 Project Ledger 상태와 대상 레코드를 순서대로 확인합니다.",
      public_rationale: "실제 canonical 상태를 읽어야 정확한 답을 만들 수 있습니다.",
      immediate_next_step: "전체 상태를 확인한 뒤 대상 레코드를 읽습니다.",
    }),
    runFunctionToolPromptText: async (input) => {
      mainLoopCalls += 1;
      const openingCall = { name: "project_ledger_status", args: {} };
      await input.onAssistantTextBeforeTools?.({ text: "", toolCalls: [openingCall] });
      await input.executeTool({ ...openingCall, rawArguments: "{}" });

      const selectedArgs = { id: "SPEC-TURN-KERNEL-FORWARD-PROGRESS-LOOP" };
      const invalidBlock = {
        name: "run_work_block",
        args: {
          decision: {
            block_title: "대상 Project Ledger 레코드의 내용을 읽습니다.",
            objective: "대상 Project Ledger 레코드의 내용을 읽습니다.",
            rationale: "첫 상태 조회를 구체적인 레코드 근거로 좁혀야 합니다.",
            next_step: "레코드 내용을 확인한 뒤 상태 보고를 마무리합니다.",
          },
          calls: [{ name: "project_ledger_show", args: selectedArgs }],
        },
      };
      await input.onAssistantTextBeforeTools?.({ text: "", toolCalls: [invalidBlock] });
      invalidResult = await input.executeTool({
        ...invalidBlock,
        rawArguments: JSON.stringify(invalidBlock.args),
      });

      const correctedBlock = testWorkBlock(
        "대상 Ledger 레코드 확인",
        "project_ledger_show",
        selectedArgs,
      );
      await input.onAssistantTextBeforeTools?.({ text: "", toolCalls: [correctedBlock] });
      await input.executeTool({ ...correctedBlock, rawArguments: JSON.stringify(correctedBlock.args) });
      return "Project Ledger 상태와 대상 레코드를 모두 확인했습니다.";
    },
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      return {
        ok: true,
        evidence_capability_receipts: [createEvidenceCapabilityReceipt({
          producer: { kind: "project_ledger", name: call.name },
          capability: "source_verified",
          evidence_kind: "project_state",
          summary: `${call.name} canonical evidence was verified.`,
        })],
      };
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/typed-tool-only-decision-repair",
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy. Answer in Korean.",
    metadata: { projectId: "butler" },
  });
  const result = await runtime.runTurn({
    handle,
    provider: typedProvider,
    model: "openai/gpt-5.5",
    input: { text: "Project Ledger 상태와 핵심 스펙을 확인해줘." },
    metadata: { thinFirstResponse: "app_default", runtimePolicy: { completionReview: "disabled" } },
    emitTurnEvent: (event) => {
      events.push(event);
    },
  });

  expect(result.text).toContain("모두 확인");
  expect(mainLoopCalls).toBe(1);
  expect(executedTools).toEqual(["project_ledger_status", "project_ledger_show"]);
  expect(invalidResult).toMatchObject({
    butler_work_block_result: true,
    decision_feedback: {
      correction: "Keep block_title as a shorter label distinct from objective.",
    },
    results: [],
  });
  const blocks = events.filter((event) => event.kind === "work.block.started");
  expect(blocks).toHaveLength(2);
  expect(new Set(blocks.map((event) => event.payload?.decisionId)).size).toBe(2);
});

test("later provider rounds carry one structured decision control call beside semantic tools", async () => {
  const events: RuntimeTurnEventInput[] = [];
  const executedArgs: Array<Record<string, unknown>> = [];
  let fallbackRepairCalls = 0;
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => JSON.stringify({
      schema_version: "butler.turn-contract-decision.v1",
      decision_id: decisionIdFromFormat(input.responseFormat),
      action: "inspect",
      target_workstream_id: null,
      target_project_id: "butler",
      blocker_id: null,
      evidence_domain: null,
      inspection_scope: "project",
      deliverables: ["status_report"],
      answer_text: null,
      public_title: "Project Ledger 근거 확인",
      public_summary: "Project Ledger 상태와 핵심 스펙을 두 단계로 확인합니다.",
      public_rationale: "canonical 상태와 구체적인 스펙 근거가 모두 필요합니다.",
      immediate_next_step: "전체 상태를 확인한 뒤 핵심 스펙을 읽습니다.",
    }),
    runFunctionToolPromptText: async (input) => {
      if (input.tools.some((tool) => tool.name === "submit_work_block_decision")) {
        fallbackRepairCalls += 1;
        throw new Error("structured tool envelope should avoid fallback repair");
      }
      const initialTools = input.dynamicTools?.() ?? input.tools;
      expect(initialTools.map((tool) => tool.name)).toEqual(["run_work_block"]);
      expect(workBlockCatalogNames(initialTools)).toContain("project_ledger_show");

      const openingCall = { name: "project_ledger_status", args: {} };
      await input.onAssistantTextBeforeTools?.({ text: "", toolCalls: [openingCall] });
      await input.executeTool({ ...openingCall, rawArguments: "{}" });

      const laterTools = input.dynamicTools?.() ?? input.tools;
      expect(laterTools.map((tool) => tool.name)).toEqual(["run_work_block"]);
      const decisionArgs = {
        block_title: "핵심 스펙 내용 확인",
        objective: "Project Ledger에서 핵심 forward-progress 스펙의 실제 내용을 읽습니다.",
        rationale: "전체 상태 조회를 구체적인 source evidence로 좁혀야 합니다.",
        next_step: "스펙 내용을 확인한 뒤 상태 보고를 완료합니다.",
        expected_effect: "핵심 스펙의 canonical 내용이 근거로 추가됩니다.",
        repeat_reason: null,
        completion_obligations: ["source_verified"],
      };
      const selectedArgs = { id: "SPEC-TURN-KERNEL-FORWARD-PROGRESS-LOOP" };
      const workBlockCall = {
        name: "run_work_block",
        args: {
          decision: decisionArgs,
          calls: [{ name: "project_ledger_show", args: selectedArgs }],
        },
      };
      await input.onAssistantTextBeforeTools?.({
        text: "",
        toolCalls: [workBlockCall],
      });
      await input.executeTool({
        ...workBlockCall,
        rawArguments: JSON.stringify(workBlockCall.args),
      });
      return "Project Ledger 상태와 핵심 스펙을 확인했습니다.";
    },
    executeButlerTool: async (call) => {
      executedArgs.push(call.args);
      return {
        ok: true,
        evidence_capability_receipts: [createEvidenceCapabilityReceipt({
          producer: { kind: "project_ledger", name: call.name },
          capability: "source_verified",
          evidence_kind: "project_state",
          summary: `${call.name} canonical evidence was verified.`,
        })],
      };
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/typed-tool-decision-envelope",
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy. Answer in Korean.",
    metadata: { projectId: "butler" },
  });
  const result = await runtime.runTurn({
    handle,
    provider: {
      ...typedProvider,
      capabilities: {
        ...typedProvider.capabilities,
        supportsSameTurnToolSchemaPromotion: true,
      },
    },
    model: "openai/gpt-5.5",
    input: { text: "Project Ledger 상태와 핵심 스펙을 확인해줘." },
    metadata: { thinFirstResponse: "app_default", runtimePolicy: { completionReview: "disabled" } },
    emitTurnEvent: (event) => {
      events.push(event);
    },
  });

  expect(result.text).toContain("핵심 스펙");
  expect(fallbackRepairCalls).toBe(0);
  expect(executedArgs).toHaveLength(2);
  expect(executedArgs[1]).toEqual({ id: "SPEC-TURN-KERNEL-FORWARD-PROGRESS-LOOP" });
  expect(events.filter((event) => event.kind === "work.block.started")).toHaveLength(2);
});

test("typed completion gaps stay in one provider invocation and preserve the obligation frontier", async () => {
  let toolPromptInvocations = 0;
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => JSON.stringify({
      schema_version: "butler.turn-contract-decision.v1",
      decision_id: decisionIdFromFormat(input.responseFormat),
      action: "start_work",
      target_workstream_id: null,
      target_project_id: "butler",
      blocker_id: null,
      deliverables: ["code_change", "validation", "final_report"],
      answer_text: null,
      public_title: "동일 provider 완료 검증",
      public_summary: "파일 변경과 구조화 검증을 같은 provider 대화에서 완료합니다.",
      public_rationale: "완료 공백이 이전 작업 상태를 초기화하면 안 됩니다.",
      immediate_next_step: "파일을 변경한 뒤 구조화 검증을 실행합니다.",
    }),
    runFunctionToolPromptText: async (input) => {
      toolPromptInvocations += 1;
      expect(workBlockCatalogNames(input.dynamicTools?.() ?? input.tools)).toEqual([
        "update_todo_list",
        "list_todo_list",
      ]);
      await input.executeTool({
        name: "update_todo_list",
        args: {
          todos: [{
            id: "implement",
            content: "대상 파일을 변경합니다.",
            active_form: "대상 파일을 변경하는 중입니다.",
            status: "in_progress",
            phase: "execution",
          }, {
            id: "validate",
            content: "변경 결과를 검증합니다.",
            active_form: "변경 결과를 검증하는 중입니다.",
            status: "pending",
            phase: "review",
            blocked_by: ["implement"],
          }, {
            id: "report",
            content: "완료 결과를 보고합니다.",
            active_form: "완료 결과를 보고하는 중입니다.",
            status: "pending",
            phase: "reporting",
            blocked_by: ["validate"],
          }],
        },
        rawArguments: JSON.stringify({ todos: [] }),
      });
      expect(workBlockCatalogNames(input.dynamicTools?.() ?? input.tools)).toContain("write_file");
      const writeBlock = testWorkBlock("파일 변경", "write_file", {
        path: "same-provider.txt",
        content: "changed",
        overwrite: false,
      });
      await input.onAssistantTextBeforeTools?.({ text: "", toolCalls: [writeBlock] });
      await input.executeTool({ ...writeBlock, rawArguments: JSON.stringify(writeBlock.args) });

      const premature = await input.reviewFinalCandidate?.({ text: "변경을 완료했습니다.", roundIndex: 1 });
      expect(premature).toMatchObject({ status: "continue" });
      const prematureObservation = premature?.status === "continue" ? premature.observation : "";
      expect(prematureObservation).toContain("contract-bound work plan is not complete");
      expect(prematureObservation).toContain("validation");
      expect(prematureObservation).not.toContain("- final_report:");
      expect(workBlockCatalogNames(input.dynamicTools?.() ?? input.tools)).toEqual(["run_command"]);

      const validationBlock = testWorkBlock("구조화 검증", "run_command", {
        command: "bun test same-provider",
        validation_suite: "same-provider",
      });
      await input.onAssistantTextBeforeTools?.({ text: "", toolCalls: [validationBlock] });
      await input.executeTool({ ...validationBlock, rawArguments: JSON.stringify(validationBlock.args) });

      const planGap = await input.reviewFinalCandidate?.({ text: "변경과 검증을 완료했습니다.", roundIndex: 2 });
      expect(planGap).toMatchObject({ status: "continue" });
      const planObservation = planGap?.status === "continue" ? planGap.observation : "";
      expect(planObservation).toContain("implement: status=in_progress; phase=execution");
      expect(planObservation).toContain("validate: status=pending; phase=review");
      expect(planObservation).not.toContain("typed deliverables also still need evidence");

      const closeoutBlock = testWorkBlock("진행 상태 마감", "update_todo_list", {
        todos: [{
          id: "implement",
          content: "대상 파일을 변경합니다.",
          active_form: "대상 파일을 변경하는 중입니다.",
          status: "completed",
          phase: "execution",
        }, {
          id: "validate",
          content: "변경 결과를 검증합니다.",
          active_form: "변경 결과를 검증하는 중입니다.",
          status: "completed",
          phase: "review",
          blocked_by: ["implement"],
        }, {
          id: "report",
          content: "완료 결과를 보고합니다.",
          active_form: "완료 결과를 보고하는 중입니다.",
          status: "pending",
          phase: "reporting",
          blocked_by: ["validate"],
        }],
      });
      await input.onAssistantTextBeforeTools?.({ text: "", toolCalls: [closeoutBlock] });
      await input.executeTool({ ...closeoutBlock, rawArguments: JSON.stringify(closeoutBlock.args) });

      const accepted = await input.reviewFinalCandidate?.({ text: "파일 변경과 검증을 완료했습니다.", roundIndex: 3 });
      expect(accepted).toMatchObject({ status: "accepted" });
      return accepted?.status === "accepted" && accepted.text
        ? accepted.text
        : "파일 변경과 검증을 완료했습니다.";
    },
    executeButlerTool: async (call) => ({
      ok: true,
      evidence_capability_receipts: call.name === "write_file"
        ? [createEvidenceCapabilityReceipt({
          producer: { kind: "tool", name: "write_file" },
          capability: "workspace_mutated",
          evidence_kind: "mutation_result",
          summary: "Workspace mutation was persisted.",
        })]
        : call.name === "run_command"
        ? [createEvidenceCapabilityReceipt({
          producer: { kind: "tool", name: "run_command" },
          capability: "validation_passed",
          evidence_kind: "execution_result",
          summary: "Structured validation passed.",
        })]
        : [],
    }),
  });
  const handle = await runtime.createSession({
    sessionId: "butler/typed-provider-continuation",
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy.",
    metadata: { projectId: "butler" },
  });
  const result = await runtime.runTurn({
    handle,
    provider: typedProvider,
    model: "openai/gpt-5.5",
    input: { text: "파일을 변경하고 검증까지 완료해줘." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(result.text).toContain("완료");
  expect(result.delivery).toBeUndefined();
  expect(toolPromptInvocations).toBe(1);
  const deliveredContract = readOnlyContract();
  expect(deliveredContract).toMatchObject({ state: "delivered" });
  expect(new WorkStreamStore(data).read(String(deliveredContract.target_workstream_id)))
    .toMatchObject({ state: "complete" });
});

test("typed execution survives repeated focused-action repair and completes with a direct write", async () => {
  const sessionId = "butler/typed-workspace-action-frontier";
  const turnId = "turn-typed-workspace-action-frontier";
  const events: RuntimeTurnEventInput[] = [];
  const executedReads: string[] = [];
  const executedCommands: string[] = [];
  const executedWrites: string[] = [];
  let rejectedBatch: unknown;
  let failedRepairBatch: unknown;
  let repairBatch: unknown;
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => JSON.stringify({
      schema_version: "butler.turn-contract-decision.v1",
      decision_id: decisionIdFromFormat(input.responseFormat),
      action: "start_work",
      target_workstream_id: null,
      target_project_id: "butler",
      blocker_id: null,
      deliverables: ["code_change", "final_report"],
      answer_text: null,
      public_title: "탐색 루프 차단 검증",
      public_summary: "필요한 소스를 확인한 뒤 실제 변경까지 끝냅니다.",
      public_rationale: "읽기만 반복하지 않고 상태 변경으로 전진해야 합니다.",
      immediate_next_step: "작업목록을 만든 뒤 필요한 파일만 확인합니다.",
    }),
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "update_todo_list",
        args: {
          todos: [{
            id: "inspect-and-change",
            content: "필요한 소스를 확인하고 실제 변경을 적용합니다.",
            active_form: "소스를 확인하고 변경을 적용하는 중입니다.",
            status: "in_progress",
            phase: "execution",
          }],
        },
        rawArguments: "{}",
      });

      const readBlock = async (block: number, count: number, offset: number) => {
        const call = {
          name: "run_work_block",
          args: {
            decision: {
              block_title: `근거 범위 ${block} 확인`,
              objective: `변경 대상 근거 범위 ${block}의 실제 소스를 확인합니다.`,
              rationale: "구현 대상을 좁히는 데 필요한 bounded source evidence입니다.",
              next_step: "확인 결과를 바탕으로 실제 변경 단계로 이동합니다.",
              expected_effect: "변경 대상 파일의 현재 내용이 확인됩니다.",
              repeat_reason: null,
              completion_obligations: [],
            },
            calls: Array.from({ length: count }, (_, index) => ({
              name: "read_file",
              args: { path: `src/evidence-${offset + index}.ts` },
            })),
          },
        };
        await input.onAssistantTextBeforeTools?.({ text: "", toolCalls: [call] });
        return await input.executeTool({
          ...call,
          rawArguments: JSON.stringify(call.args),
        });
      };

      await readBlock(1, 6, 0);
      await readBlock(2, 6, 6);

      const focusedTools = input.dynamicTools?.() ?? input.tools;
      expect(workBlockCatalogNames(focusedTools)).toEqual(expect.arrayContaining([
        "update_todo_list",
        "write_file",
        "run_command",
      ]));
      expect(workBlockCatalogNames(focusedTools)).not.toContain("read_file");
      expect(workBlockCatalogNames(focusedTools)).not.toContain("grep_files");

      const rejectedCall = {
        name: "run_work_block",
        args: {
          decision: {
            block_title: "집중 단계의 상태 확인 시도",
            objective: "두 상태 확인 명령이 변경을 만들지 않는지 검증합니다.",
            rationale: "provider가 한 응답에 잘못 묶은 호출은 한 번만 교정되어야 합니다.",
            next_step: "교정 결과를 받은 뒤 실제 파일 변경을 수행합니다.",
            expected_effect: "첫 호출만 실행되고 하나의 구조화 교정이 반환됩니다.",
            repeat_reason: null,
            completion_obligations: [],
          },
          calls: [
            {
              name: "run_command",
              args: { command: "git status --short", state_effect: "mutation" },
            },
            {
              name: "run_command",
              args: { command: "git diff --stat", state_effect: "mutation" },
            },
          ],
        },
      };
      await input.onAssistantTextBeforeTools?.({ text: "", toolCalls: [rejectedCall] });
      rejectedBatch = await input.executeTool({
        ...rejectedCall,
        rawArguments: JSON.stringify(rejectedCall.args),
      });

      const strictTools = input.dynamicTools?.() ?? input.tools;
      expect(workBlockCatalogNames(strictTools)).toEqual(expect.arrayContaining([
        "update_todo_list",
        "write_file",
      ]));
      expect(workBlockCatalogNames(strictTools)).not.toContain("run_command");
      expect(workBlockCatalogNames(strictTools)).not.toContain("read_file");

      const failedRepairCall = {
        name: "run_work_block",
        args: {
          decision: {
            block_title: "첫 직접 변경 실패",
            objective: "직접 파일 변경 실패를 구조화 관찰로 돌려받습니다.",
            rationale: "두 번째 교정도 사용자 턴을 실패시키지 않아야 합니다.",
            next_step: "실패 원인을 반영해 같은 직접 변경을 다시 시도합니다.",
            expected_effect: "직접 변경 전용 surface가 유지됩니다.",
            repeat_reason: null,
            completion_obligations: [],
          },
          calls: [{
            name: "write_file",
            args: { path: "src/failed.ts", content: "not persisted", overwrite: false },
          }],
        },
      };
      await input.onAssistantTextBeforeTools?.({ text: "", toolCalls: [failedRepairCall] });
      failedRepairBatch = await input.executeTool({
        ...failedRepairCall,
        rawArguments: JSON.stringify(failedRepairCall.args),
      });
      input.usageAttribution?.beforeModelRequest?.({ roundIndex: 1 });

      const repairCall = {
        name: "run_work_block",
        args: {
          decision: {
            block_title: "검증된 직접 파일 변경",
            objective: "직접 파일 변경을 적용하고 durable mutation evidence를 남깁니다.",
            rationale: "간접 셸 명령 없이 구조화된 쓰기 도구로 변경을 완료해야 합니다.",
            next_step: "변경 후 작업목록을 완료하고 최종 결과를 보고합니다.",
            expected_effect: "workspace_action focus가 해제됩니다.",
            repeat_reason: null,
            completion_obligations: ["durable_artifact"],
          },
          calls: [{
            name: "write_file",
            args: { path: "src/fixed.ts", content: "fixed", overwrite: false },
          }],
        },
      };
      await input.onAssistantTextBeforeTools?.({ text: "", toolCalls: [repairCall] });
      repairBatch = await input.executeTool({
        ...repairCall,
        rawArguments: JSON.stringify(repairCall.args),
      });
      expect(repairBatch).toMatchObject({
        butler_work_block_result: true,
        results: [expect.objectContaining({ ok: true })],
      });
      await input.executeTool({
        name: "update_todo_list",
        args: {
          todos: [{
            id: "inspect-and-change",
            content: "필요한 소스를 확인하고 실제 변경을 적용합니다.",
            active_form: "소스를 확인하고 변경을 적용하는 중입니다.",
            status: "completed",
            phase: "execution",
          }],
        },
        rawArguments: "{}",
      });
      input.usageAttribution?.beforeModelRequest?.({ roundIndex: 2 });
      return "수정과 검증을 완료했습니다.";
    },
    executeButlerTool: async (call) => {
      if (call.name === "read_file") executedReads.push(String(call.args.path));
      if (call.name === "run_command") executedCommands.push(String(call.args.command));
      if (call.name === "write_file") executedWrites.push(String(call.args.path));
      if (call.name === "write_file" && call.args.path === "src/failed.ts") {
        return { ok: false, error: "simulated_write_conflict" };
      }
      return {
        ok: true,
        evidence_capability_receipts: call.name === "read_file"
          ? [createEvidenceCapabilityReceipt({
            producer: { kind: "tool", name: "read_file" },
            capability: "source_verified",
            evidence_kind: "workspace_inspection",
            summary: "A bounded source file was verified.",
          })]
          : call.name === "run_command" && String(call.args.command).startsWith("python3")
          ? [createEvidenceCapabilityReceipt({
            producer: { kind: "tool", name: "run_command" },
            capability: "durable_artifact",
            evidence_kind: "artifact",
            summary: "A script command produced a verified workspace file mutation.",
          })]
          : call.name === "run_command"
          ? [createEvidenceCapabilityReceipt({
            producer: { kind: "tool", name: "run_command" },
            capability: "command_executed",
            evidence_kind: "execution_result",
            summary: "A read-only command completed without mutation evidence.",
          })]
          : [],
      };
    },
  });
  const handle = await runtime.createSession({
    sessionId,
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy.",
    metadata: { projectId: "butler" },
  });

  const result = await runtime.runTurn({
    handle,
    provider: typedProvider,
    model: "openai/gpt-5.5",
    input: { text: "조사만 반복하지 말고 변경과 보고까지 끝내줘." },
    metadata: {
      turnId,
      runtimePolicy: { completionReview: "disabled" },
    },
    emitTurnEvent: (event) => {
      events.push(event);
    },
  });

  expect(result.text).toContain("완료");
  expect(executedReads).toHaveLength(12);
  expect(executedCommands).toHaveLength(1);
  expect(executedCommands[0]).toBe("git status --short");
  expect(executedWrites).toEqual(["src/failed.ts", "src/fixed.ts"]);
  expect(rejectedBatch).toMatchObject({
    butler_work_block_result: true,
    results: [
      expect.objectContaining({
        ok: false,
        output: expect.objectContaining({
          butler_forward_progress_observation: expect.objectContaining({
            code: "workspace_action_required",
            terminal: false,
          }),
        }),
      }),
    ],
  });
  expect(failedRepairBatch).toMatchObject({
    butler_work_block_result: true,
    results: [
      expect.objectContaining({
        ok: false,
        output: expect.objectContaining({
          butler_forward_progress_observation: expect.objectContaining({
            code: "workspace_action_required",
            terminal: false,
          }),
        }),
      }),
    ],
  });
  expect(new WorkStreamStore(data).recordsForTurn(turnId)[0]).toMatchObject({
    state: "complete",
  });
  expect(events.some((event) => event.kind === "turn.failed")).toBe(false);
});

test("principal cancellation blocks the next typed workspace tool and provider request", async () => {
  const sessionId = "butler/typed-principal-cancel";
  const turnId = "turn-typed-principal-cancel";
  const controller = new AbortController();
  const unregister = registerPrincipalTurnAbortController({
    butlerData: data,
    turnId,
    controller,
  });
  let workspaceToolCalls = 0;
  let providerRequestsAfterCancel = 0;
  let toolFailure: unknown;
  let providerFailure: unknown;
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => JSON.stringify({
      schema_version: "butler.turn-contract-decision.v1",
      decision_id: decisionIdFromFormat(input.responseFormat),
      action: "start_work",
      target_workstream_id: null,
      target_project_id: "butler",
      blocker_id: null,
      deliverables: ["code_change", "final_report"],
      answer_text: null,
      public_title: "취소 경계 검증",
      public_summary: "작업목록을 만든 뒤 대상 파일을 변경합니다.",
      public_rationale: "취소 전후의 tool authority를 구분해야 합니다.",
      immediate_next_step: "명시적 계획을 만든 뒤 파일을 변경합니다.",
    }),
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "update_todo_list",
        args: {
          todos: [{
            id: "implement",
            content: "대상 파일을 변경합니다.",
            active_form: "대상 파일을 변경하는 중입니다.",
            status: "in_progress",
            phase: "execution",
          }],
        },
        rawArguments: "{}",
      });
      cancelPersistedRuntimeTurn({ butlerData: data, turnId });
      try {
        await input.executeTool({
          name: "write_file",
          args: { path: "must-not-run.txt", content: "cancelled" },
          rawArguments: JSON.stringify({ path: "must-not-run.txt", content: "cancelled" }),
        });
      } catch (error) {
        toolFailure = error;
      }
      try {
        input.usageAttribution?.beforeModelRequest?.({ roundIndex: 1 });
        providerRequestsAfterCancel += 1;
      } catch (error) {
        providerFailure = error;
      }
      throw providerFailure;
    },
    executeButlerTool: async (call) => {
      if (call.name === "write_file") workspaceToolCalls += 1;
      return { ok: true };
    },
  });
  const handle = await runtime.createSession({
    sessionId,
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy.",
    metadata: { projectId: "butler" },
  });

  let failure: unknown;
  try {
    await runtime.runTurn({
      handle,
      provider: typedProvider,
      model: "openai/gpt-5.5",
      input: { text: "파일을 변경해줘." },
      signal: controller.signal,
      metadata: { turnId, runtimePolicy: { completionReview: "disabled" } },
    });
  } catch (error) {
    failure = error;
  } finally {
    unregister();
  }

  expect(controller.signal.aborted).toBe(true);
  expect(toolFailure).toMatchObject({ name: "AbortError" });
  expect(providerFailure).toMatchObject({ name: "AbortError" });
  expect(failure).toBe(providerFailure);
  expect(workspaceToolCalls).toBe(0);
  expect(providerRequestsAfterCancel).toBe(0);
});

test("principal cancellation aborts an active default run_command process tree", async () => {
  const sessionId = "butler/typed-active-command-cancel";
  const turnId = "turn-typed-active-command-cancel";
  const controller = new AbortController();
  const unregister = registerPrincipalTurnAbortController({
    butlerData: data,
    turnId,
    controller,
  });
  const startedPath = join(data, "runtime-command-started.txt");
  const latePath = join(data, "runtime-command-late.txt");
  const events: RuntimeTurnEventInput[] = [];
  let cancelledAt = 0;
  let commandSettledAt = 0;
  const command = [
    "printf 'started\\n' > runtime-command-started.txt",
    "/bin/sh -c \"sleep 1; printf 'late\\n' > runtime-command-late.txt\"",
  ].join("; ");
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => JSON.stringify({
      schema_version: "butler.turn-contract-decision.v1",
      decision_id: decisionIdFromFormat(input.responseFormat),
      action: "start_work",
      target_workstream_id: null,
      target_project_id: "butler",
      blocker_id: null,
      deliverables: ["validation"],
      answer_text: null,
      public_title: "활성 명령 취소 검증",
      public_summary: "작업목록을 만든 뒤 장기 포그라운드 명령을 실행합니다.",
      public_rationale: "취소 신호가 실제 명령 프로세스 트리까지 전파되어야 합니다.",
      immediate_next_step: "명령 실행 중 취소하고 지연 쓰기가 없는지 확인합니다.",
    }),
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "update_todo_list",
        args: {
          todos: [{
            id: "run",
            content: "장기 포그라운드 명령을 실행합니다.",
            active_form: "장기 포그라운드 명령을 실행하는 중입니다.",
            status: "in_progress",
            phase: "execution",
          }, {
            id: "verify",
            content: "취소 후 지연 쓰기가 없는지 검증합니다.",
            active_form: "취소 후 지연 쓰기를 검증하는 중입니다.",
            status: "pending",
            phase: "review",
            blocked_by: ["run"],
          }],
        },
        rawArguments: "{}",
      });
      const block = testWorkBlock("장기 명령 실행", "run_command", {
        command,
        timeout_ms: 30_000,
        validation_suite: "active-command-cancellation",
      });
      await input.onAssistantTextBeforeTools?.({ text: "", toolCalls: [block] });
      const cancelWhenStarted = (async () => {
        for (let attempt = 0; attempt < 200 && !existsSync(startedPath); attempt += 1) {
          await Bun.sleep(10);
        }
        expect(existsSync(startedPath)).toBe(true);
        cancelledAt = Date.now();
        cancelPersistedRuntimeTurn({ butlerData: data, turnId });
      })();
      await input.executeTool({
        ...block,
        rawArguments: JSON.stringify(block.args),
      });
      commandSettledAt = Date.now();
      await cancelWhenStarted;
      return "취소 뒤에는 전달되면 안 됩니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId,
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy.",
    metadata: { projectId: "butler" },
  });

  let failure: unknown;
  try {
    await runtime.runTurn({
      handle,
      provider: typedProvider,
      model: "openai/gpt-5.5",
      input: { text: "장기 명령 취소를 검증해줘." },
      signal: controller.signal,
      metadata: { turnId, runtimePolicy: { completionReview: "disabled" } },
      emitTurnEvent: (event) => {
        events.push(event);
      },
    });
  } catch (error) {
    failure = error;
  } finally {
    unregister();
  }

  expect(controller.signal.aborted).toBe(true);
  expect(failure).toMatchObject({ name: "AbortError" });
  expect(cancelledAt).toBeGreaterThan(0);
  expect(commandSettledAt).toBeGreaterThanOrEqual(cancelledAt);
  expect(commandSettledAt - cancelledAt).toBeLessThan(2_000);
  await Bun.sleep(1_200);
  expect(existsSync(latePath)).toBe(false);
  expect(events.some((event) =>
    event.kind === "tool.started" &&
    (event.payload as Record<string, unknown> | undefined)?.toolName === "Bash",
  )).toBe(true);
  expect(events.some((event) => event.kind === "tool.completed")).toBe(false);
});

test("workspace inspect exposes direct read tools without mutation tools", async () => {
  let selectedTools: string[] = [];
  let selectedMaxToolRounds: number | undefined;
  let selectedInstructions = "";
  let fixedWorkspaceRootFields: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => JSON.stringify({
      schema_version: "butler.turn-contract-decision.v1",
      decision_id: decisionIdFromFormat(input.responseFormat),
      action: "inspect",
      target_workstream_id: null,
      target_project_id: null,
      blocker_id: null,
      evidence_domain: null,
      inspection_scope: "workspace",
      deliverables: ["status_report"],
      answer_text: null,
      public_summary: "저장소 설정을 기존 소스에서 확인해야 합니다.",
      immediate_next_step: "관련 설정명을 좁게 검색합니다.",
    }),
    runFunctionToolPromptText: async (input) => {
      selectedTools = workBlockCatalogNames(input.tools);
      selectedMaxToolRounds = input.maxToolRounds;
      selectedInstructions = input.instructions ?? "";
      fixedWorkspaceRootFields = input.tools
        .filter((tool) => tool.name === "read_file" || tool.name === "grep_files")
        .flatMap((tool) => Object.keys(
          (tool.parameters.properties ?? {}) as Record<string, unknown>,
        ))
        .filter((key) => key === "workspace_root");
      await input.executeTool({
        name: "read_file",
        args: { path: "packages/butler-agent/src/integrations/providers/provider.ts" },
        rawArguments: JSON.stringify({ path: "packages/butler-agent/src/integrations/providers/provider.ts" }),
      });
      return "설정 파일과 함수명을 확인했습니다.";
    },
    executeButlerTool: async () => ({
      ok: true,
      evidence_capability_receipts: [createEvidenceCapabilityReceipt({
        producer: { kind: "tool", name: "read-file" },
        capability: "source_verified",
        evidence_kind: "workspace_inspection",
        summary: "Workspace source was inspected.",
      })],
    }),
  });
  const handle = await runtime.createSession({
    sessionId: "butler/typed-workspace-inspect",
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy.",
  });
  const result = await runtime.runTurn({
    handle,
    provider: typedProvider,
    model: "openai/gpt-5.5",
    input: { text: "저장소의 prompt cache 설정 함수를 확인해줘." },
    metadata: { thinFirstResponse: "app_default", runtimePolicy: { completionReview: "disabled" } },
  });

  expect(result.text).toContain("확인");
  expect(selectedTools.sort()).toEqual([
    "grep_files",
    "read_file",
    "read_tool_evidence_artifact",
    "read_tool_output_artifact",
  ].sort());
  expect(selectedMaxToolRounds).toBeGreaterThan(1);
  expect(selectedInstructions).toContain("## Fixed Butler Tool Surface");
  expect(selectedInstructions).not.toContain("`run_command`");
  expect(selectedInstructions).not.toContain("`tool_search`");
  expect(selectedInstructions).toContain("active workspace root is already owned by the session");
  expect(fixedWorkspaceRootFields).toEqual([]);
  expect(readOnlyContract()).toMatchObject({ action: "inspect", state: "delivered" });
});

test("workspace search candidates continue into source verification before delivery", async () => {
  const toolPrompts: string[] = [];
  const textPrompts: string[] = [];
  const executedTools: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => {
      if (!input.responseFormat) {
        textPrompts.push(input.prompt);
        return "provider.ts를 읽어 캐시 설정 함수를 확인했습니다.";
      }
      return JSON.stringify({
        schema_version: "butler.turn-contract-decision.v1",
        decision_id: decisionIdFromFormat(input.responseFormat),
        action: "inspect",
        target_workstream_id: null,
        target_project_id: null,
        blocker_id: null,
        evidence_domain: null,
        inspection_scope: "workspace",
        deliverables: ["status_report"],
        answer_text: null,
        public_summary: "실제 소스에서 캐시 설정 파일과 함수명을 확인해야 합니다.",
        immediate_next_step: "관련 키워드로 후보 파일을 검색합니다.",
      });
    },
    runFunctionToolPromptText: async (input) => {
      expect(input.maxToolRounds).toBeGreaterThan(1);
      expect(input.handoffAfterToolBatch).toBe(false);
      expect(workBlockCatalogNames(input.tools).sort()).toEqual([
        "grep_files",
        "read_file",
        "read_tool_evidence_artifact",
        "read_tool_output_artifact",
      ].sort());
      toolPrompts.push(input.prompt);
      const grepArgs = { pattern: "prompt_cache" };
      await input.onAssistantTextBeforeTools?.({
        text: "",
        toolCalls: [{ name: "grep_files", args: grepArgs }],
      });
      await input.executeTool({ name: "grep_files", args: grepArgs, rawArguments: JSON.stringify(grepArgs) });
      const readArgs = { path: "packages/butler-agent/src/integrations/providers/provider.ts" };
      await input.onAssistantTextBeforeTools?.({
        text: [
          "title: 캐시 소스 확인",
          "summary: 검색 결과에서 캐시 설정 구현을 확인합니다.",
          "rationale: 실제 함수명을 검증해야 요청에 답할 수 있습니다.",
          "next_step: 읽은 구현을 근거로 최종 답을 작성합니다.",
        ].join("\n"),
        toolCalls: [{ name: "read_file", args: readArgs }],
      });
      await input.executeTool({ name: "read_file", args: readArgs, rawArguments: JSON.stringify(readArgs) });
      return "provider.ts를 읽어 캐시 설정 함수를 확인했습니다.";
    },
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      return {
        ok: true,
        ...(call.name === "grep_files"
          ? {
            pattern: "prompt_cache",
            matches: [{
              path: "packages/butler-agent/src/integrations/providers/provider.ts",
              line: 710,
              text: "const retention = resolveConfiguredPromptCacheRetention();",
            }],
            truncated: false,
          }
          : {
            path: "packages/butler-agent/src/integrations/providers/provider.ts",
            start_line: 700,
            end_line: 735,
            content: "function applyOpenAiPromptCacheConfig() {}",
            truncated: false,
          }),
        evidence_capability_receipts: [call.name === "grep_files"
          ? createEvidenceCapabilityReceipt({
            producer: { kind: "tool", name: "grep_files" },
            capability: "source_candidate",
            evidence_kind: "source_candidate",
            maturity: "candidate",
            verified: false,
            summary: "Workspace search returned a candidate file.",
          })
          : createEvidenceCapabilityReceipt({
            producer: { kind: "tool", name: "read_file" },
            capability: "source_verified",
            evidence_kind: "workspace_inspection",
            summary: "Workspace source file was read and verified.",
          })],
      };
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/typed-search-then-read",
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy.",
  });
  const result = await runtime.runTurn({
    handle,
    provider: typedProvider,
    model: "openai/gpt-5.5",
    input: { text: "캐시 설정 파일과 함수명을 실제 소스에서 확인해줘." },
    metadata: { thinFirstResponse: "app_default", runtimePolicy: { completionReview: "disabled" } },
  });

  expect(executedTools).toEqual(["grep_files", "read_file"]);
  expect(toolPrompts).toHaveLength(1);
  expect(textPrompts).toHaveLength(0);
  expect(result.text).toContain("provider.ts");
  expect(readOnlyContract()).toMatchObject({ action: "inspect", state: "delivered" });
});

test("invalid typed output receives one bounded schema repair", async () => {
  let calls = 0;
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => {
      calls += 1;
      const decisionId = decisionIdFromFormat(input.responseFormat);
      if (calls === 1) return JSON.stringify({
        schema_version: "butler.turn-contract-decision.v1",
        decision_id: decisionId,
        action: "inspect",
        target_workstream_id: null,
        target_project_id: null,
        blocker_id: null,
        evidence_domain: null,
        inspection_scope: "workspace",
        deliverables: [],
        answer_text: null,
        public_summary: "Invalid inspect decision.",
        immediate_next_step: null,
      });
      expect(input.prompt).toContain("turn_contract_required_deliverable_missing");
      return JSON.stringify({
        schema_version: "butler.turn-contract-decision.v1",
        decision_id: decisionId,
        action: "answer",
        target_workstream_id: null,
        target_project_id: null,
        blocker_id: null,
        deliverables: [],
        answer_text: "복구된 직접 답변입니다.",
        public_summary: "스키마를 수정해 직접 답합니다.",
        immediate_next_step: null,
      });
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/typed-repair",
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy.",
  });
  const result = await runtime.runTurn({
    handle,
    provider: typedProvider,
    model: "openai/gpt-5.5",
    input: { text: "이전 내용을 한 문장으로 정리해줘." },
    metadata: { thinFirstResponse: "app_default", runtimePolicy: { completionReview: "disabled" } },
  });
  expect(result.text).toBe("복구된 직접 답변입니다.");
  expect(calls).toBe(2);
});

test("provider failures bypass typed decision schema repair", async () => {
  let calls = 0;
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async () => {
      calls += 1;
      throw new Error("provider_rate_limited");
    },
    runFunctionToolPromptText: async () => "unexpected",
  });
  const handle = await runtime.createSession({
    sessionId: "butler/typed-provider-failure",
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy.",
  });

  await expect(runtime.runTurn({
    handle,
    provider: typedProvider,
    model: "openai/gpt-5.5",
    input: { text: "현재 상태를 알려줘." },
    metadata: { thinFirstResponse: "app_default", runtimePolicy: { completionReview: "disabled" } },
  })).rejects.toThrow("provider_rate_limited");
  expect(calls).toBe(1);
});

test("function-tool transport canonicalizes auxiliary fields and repairs other typed errors in-band", async () => {
  let decisionCalls = 0;
  let publicToolCalls = 0;
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async () => {
      throw new Error("json_schema_path_must_not_run");
    },
    runFunctionToolPromptText: async (input) => {
      if (input.tools.length === 1 && input.tools[0]?.name === "submit_turn_decision") {
        const decisionId = decisionIdFromToolParameters(input.tools[0].parameters);
        const invalidArgs = {
          schema_version: "butler.turn-contract-decision.v1",
          decision_id: decisionId,
          action: "inspect",
          target_workstream_id: null,
          target_project_id: "butler",
          blocker_id: null,
          evidence_domain: null,
          inspection_scope: "project",
          deliverables: [],
          answer_text: "이 값은 비-answer 액션에서 허용되지 않습니다.",
          public_summary: "현재 프로젝트 설정을 실제 소스에서 확인해야 합니다.",
          immediate_next_step: "관련 설정 파일을 한 번 조회합니다.",
        };
        decisionCalls += 1;
        const invalidOutput = await input.executeTool({
          name: "submit_turn_decision",
          args: invalidArgs,
          rawArguments: JSON.stringify(invalidArgs),
        });
        expect(invalidOutput).toMatchObject({
          accepted: false,
          error_code: "turn_contract_required_deliverable_missing",
        });
        expect(JSON.stringify(invalidOutput)).toContain("inspect requires status_report");
        expect(await input.finalTextFromToolResult?.({
          name: "submit_turn_decision",
          args: invalidArgs,
          output: invalidOutput,
        })).toBeNull();

        const validArgs = { ...invalidArgs, deliverables: ["status_report"] };
        decisionCalls += 1;
        const validOutput = await input.executeTool({
          name: "submit_turn_decision",
          args: validArgs,
          rawArguments: JSON.stringify(validArgs),
        });
        const finalText = await input.finalTextFromToolResult?.({
          name: "submit_turn_decision",
          args: validArgs,
          output: validOutput,
        }) ?? "";
        expect(JSON.parse(finalText)).toMatchObject({
          action: "inspect",
          answer_text: null,
        });
        return finalText;
      }
      publicToolCalls += 1;
      expect(workBlockCatalogNames(input.tools)).toContain("project_ledger_status");
      await input.executeTool({ name: "project_ledger_status", args: {}, rawArguments: "{}" });
      return "확인한 프로젝트 설정은 정상입니다.";
    },
    executeButlerTool: async () => ({
      ok: true,
      evidence_capability_receipts: [createEvidenceCapabilityReceipt({
        producer: { kind: "project_ledger", name: "project-ledger-status" },
        capability: "source_verified",
        evidence_kind: "project_state",
        summary: "Canonical project state was verified.",
      })],
    }),
  });
  const handle = await runtime.createSession({
    sessionId: "butler/typed-function-repair",
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy.",
    metadata: { projectId: "butler" },
  });
  const result = await runtime.runTurn({
    handle,
    provider: {
      ...typedProvider,
      capabilities: {
        ...typedProvider.capabilities,
        structuredDecisionTransport: "function_tool",
      },
    },
    model: "zai/glm-5.2",
    input: { text: "현재 프로젝트 설정을 실제로 확인해줘." },
    metadata: { thinFirstResponse: "app_default", runtimePolicy: { completionReview: "disabled" } },
  });

  expect(result.text).toContain("정상");
  expect(decisionCalls).toBe(2);
  expect(publicToolCalls).toBe(1);
  expect(readOnlyContract()).toMatchObject({ action: "inspect", state: "delivered" });
});

test("function-tool transport retries once when a provider ignores the required tool channel", async () => {
  let decisionCalls = 0;
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async () => {
      throw new Error("json_schema_path_must_not_run");
    },
    runFunctionToolPromptText: async (input) => {
      decisionCalls += 1;
      if (decisionCalls === 1) return "I will inspect the request first.";
      expect(input.prompt).toContain("turn_contract_decision_invalid_json");
      const decisionId = decisionIdFromToolParameters(input.tools[0]!.parameters);
      const args = {
        schema_version: "butler.turn-contract-decision.v1",
        decision_id: decisionId,
        action: "answer",
        target_workstream_id: null,
        target_project_id: null,
        blocker_id: null,
        deliverables: [],
        answer_text: "구조화 decision 채널로 복구했습니다.",
        public_summary: "직접 답변으로 요청을 처리합니다.",
        immediate_next_step: null,
      };
      await input.executeTool({
        name: "submit_turn_decision",
        args,
        rawArguments: JSON.stringify(args),
      });
      return JSON.stringify(args);
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/typed-function-channel-repair",
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy.",
  });
  const result = await runtime.runTurn({
    handle,
    provider: {
      ...typedProvider,
      capabilities: {
        ...typedProvider.capabilities,
        structuredDecisionTransport: "function_tool",
      },
    },
    model: "zai/glm-5.2",
    input: { text: "한 문장으로 답해줘." },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(result.text).toBe("구조화 decision 채널로 복구했습니다.");
  expect(decisionCalls).toBe(2);
});

test("one semantic decision block closes only after its final tool", async () => {
  const events: RuntimeTurnEventInput[] = [];
  let selectedTools: string[] = [];
  let sawActiveTodoList = false;
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => JSON.stringify({
      schema_version: "butler.turn-contract-decision.v1",
      decision_id: decisionIdFromFormat(input.responseFormat),
      action: "start_work",
      target_workstream_id: null,
      target_project_id: "butler",
      blocker_id: null,
      deliverables: ["code_change", "validation", "final_report"],
      answer_text: null,
      public_summary: "요청한 코드 변경과 검증을 완료해야 합니다.",
      immediate_next_step: "대상 파일을 수정하고 검증을 실행합니다.",
    }),
    runFunctionToolPromptText: async (input) => {
      expect(input.maxToolRounds).toBeGreaterThan(1);
      if (input.prompt.includes("## Active Typed Turn Contract")) {
        expect(input.prompt).toContain("Active Todo List: contract-");
        expect(input.prompt).toContain("or omit list_id so the active contract binds it automatically");
        sawActiveTodoList = true;
      }
      expect(workBlockCatalogNames(input.dynamicTools?.() ?? input.tools)).toEqual([
        "update_todo_list",
        "list_todo_list",
      ]);
      const plan = [{
        id: "implement",
        content: "대상 파일을 수정합니다.",
        active_form: "대상 파일을 수정하는 중입니다.",
        status: "in_progress" as const,
        phase: "execution" as const,
      }, {
        id: "validate",
        content: "변경 결과를 검증합니다.",
        active_form: "변경 결과를 검증하는 중입니다.",
        status: "pending" as const,
        phase: "review" as const,
        blocked_by: ["implement"],
      }, {
        id: "report",
        content: "완료 결과를 보고합니다.",
        active_form: "완료 결과를 보고하는 중입니다.",
        status: "pending" as const,
        phase: "reporting" as const,
        blocked_by: ["validate"],
      }];
      await input.executeTool({
        name: "update_todo_list",
        args: { todos: plan },
        rawArguments: JSON.stringify({ todos: plan }),
      });
      selectedTools = workBlockCatalogNames(input.dynamicTools?.() ?? input.tools);
      const toolCalls = [
        { name: "write_file", args: { path: "fixture.txt", content: "done", overwrite: false } },
        { name: "run_command", args: { command: "bun test fixture", validation_suite: "fixture" } },
      ];
      await input.onAssistantTextBeforeTools?.({
        text: [
          "summary: 대상 파일을 수정하고 검증합니다.",
          "rationale: 요청된 코드 변경과 검증 증거를 함께 남겨야 합니다.",
          "next_step: 파일 변경 후 바로 테스트 결과를 확인합니다.",
        ].join("\n"),
        toolCalls,
      });
      for (const call of toolCalls) {
        await input.executeTool({ name: call.name, args: call.args, rawArguments: JSON.stringify(call.args) });
      }
      await input.executeTool({
        name: "update_todo_list",
        args: {
          todos: plan.map((todo) => todo.id === "report"
            ? todo
            : { ...todo, status: "completed" as const }),
        },
        rawArguments: JSON.stringify({ todos: [] }),
      });
      return "코드 변경과 검증을 완료했습니다.";
    },
    executeButlerTool: async (call) => ({
      ok: true,
      evidence_capability_receipts: [call.name === "write_file"
        ? createEvidenceCapabilityReceipt({
          producer: { kind: "tool", name: "write-file" },
          capability: "workspace_mutated",
          evidence_kind: "mutation_result",
          summary: "Workspace mutation was persisted.",
        })
        : createEvidenceCapabilityReceipt({
          producer: { kind: "tool", name: "test-runner" },
          capability: "validation_passed",
          evidence_kind: "execution_result",
          summary: "Validation suite passed.",
        })],
    }),
  });
  const handle = await runtime.createSession({
    sessionId: "butler/typed-work",
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy.",
    metadata: { projectId: "butler" },
  });
  const result = await runtime.runTurn({
    handle,
    provider: typedProvider,
    model: "openai/gpt-5.5",
    input: { text: "fixture를 수정하고 테스트까지 완료해줘." },
    metadata: { thinFirstResponse: "app_default", runtimePolicy: { completionReview: "disabled" } },
    emitTurnEvent: (event) => {
      events.push(event);
    },
  });
  expect(result.text).toContain("완료");
  expect(sawActiveTodoList).toBe(true);
  expect(selectedTools).toContain("write_file");
  expect(selectedTools).not.toContain("project_ledger_create");
  const blockEvents = events.filter((event) => event.kind.startsWith("work.block."));
  expect(blockEvents.map((event) => event.kind)).toEqual(["work.block.started", "work.block.completed"]);
  expect(new Set(blockEvents.map((event) => (event.payload as Record<string, unknown>).workBlockId)).size).toBe(1);
  const firstToolCompleted = events.findIndex((event) => event.kind === "tool.completed");
  const blockCompleted = events.findIndex((event) => event.kind === "work.block.completed");
  expect(blockCompleted).toBeGreaterThan(firstToolCompleted);
  const deliveredContract = readOnlyContract();
  expect(deliveredContract).toMatchObject({
    action: "start_work",
    deliverables: ["code_change", "validation", "final_report"],
    state: "delivered",
  });
  expect(deliveredContract.target_workstream_id).toBeString();
  const stream = new WorkStreamStore(data).read(String(deliveredContract.target_workstream_id));
  expect(stream).toMatchObject({ active_contract_id: null });
});

test("retryable provider failures checkpoint the active contract instead of failing the turn", async () => {
  const turnId = "turn-provider-retry-checkpoint";
  const sessionId = "butler/provider-retry-checkpoint";
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => JSON.stringify({
      schema_version: "butler.turn-contract-decision.v1",
      decision_id: decisionIdFromFormat(input.responseFormat),
      action: "start_work",
      target_workstream_id: null,
      target_project_id: "butler",
      blocker_id: null,
      deliverables: ["code_change", "validation", "final_report"],
      answer_text: null,
      public_title: "공급자 복구 체크포인트",
      public_summary: "일시적인 공급자 장애 뒤에도 같은 작업 계약을 이어갑니다.",
      public_rationale: "장시간 작업은 재시도 가능한 네트워크 실패로 종료되면 안 됩니다.",
      immediate_next_step: "공급자가 복구되면 같은 도구 라운드를 다시 실행합니다.",
    }),
    runFunctionToolPromptText: async () => {
      throw new ModelProviderRequestError({
        code: "provider_network_error",
        message: "Model provider API connection failed before a response was received.",
        provider: "zai",
        api: "chat_completions",
        model: "glm-5.2",
        retryable: true,
        cause: "The operation timed out.",
      });
    },
    executeButlerTool: async () => ({ ok: true }),
  });
  const handle = await runtime.createSession({
    sessionId,
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy.",
    metadata: { projectId: "butler" },
  });

  let yielded: unknown;
  try {
    await runtime.runTurn({
      handle,
      provider: typedProvider,
      model: "openai/gpt-5.5",
      input: { text: "파일을 변경하고 검증해줘." },
      metadata: { turnId, runtimePolicy: { completionReview: "disabled" } },
    });
  } catch (error) {
    yielded = error;
  }

  expect(isTurnSchedulerContinuationYieldError(yielded)).toBe(true);
  expect(yielded).toMatchObject({
    sourceErrorCode: "provider_network_error",
    retryableProviderFailureStreak: 1,
  });
  expect(readTurnContextAtom({ butlerData: data, sessionId, turnId })).toMatchObject({
    state: "continuing",
    contractId: expect.stringContaining("contract-"),
    nextSemanticBlockSequence: 1,
  });
});

test("scheduler resume restores one typed contract and retires its satisfied mutation frontier", async () => {
  const turnId = "turn-typed-checkpoint-resume";
  const sessionId = "butler/typed-checkpoint-resume";
  const events: RuntimeTurnEventInput[] = [];
  const budgetStates: Array<{ requestCount?: number; cumulativeRequestCount?: number }> = [];
  let typedDecisionCalls = 0;
  let toolPromptCalls = 0;
  const checkpointPlan = [{
    id: "implement",
    content: "체크포인트 대상 파일을 변경합니다.",
    active_form: "체크포인트 대상 파일을 변경하는 중입니다.",
    status: "in_progress" as const,
    phase: "execution" as const,
  }, {
    id: "validate",
    content: "변경 결과를 검증합니다.",
    active_form: "변경 결과를 검증하는 중입니다.",
    status: "pending" as const,
    phase: "review" as const,
    blocked_by: ["implement"],
  }, {
    id: "report",
    content: "완료 결과를 보고합니다.",
    active_form: "완료 결과를 보고하는 중입니다.",
    status: "pending" as const,
    phase: "reporting" as const,
    blocked_by: ["validate"],
  }];
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => {
      typedDecisionCalls += 1;
      return JSON.stringify({
        schema_version: "butler.turn-contract-decision.v1",
        decision_id: decisionIdFromFormat(input.responseFormat),
        action: "start_work",
        target_workstream_id: null,
        target_project_id: "butler",
        blocker_id: null,
        deliverables: ["code_change", "validation", "final_report"],
        answer_text: null,
        public_title: "체크포인트 재개 검증",
        public_summary: "파일 변경과 검증을 하나의 계약으로 완료합니다.",
        public_rationale: "강제 yield 뒤에도 같은 작업을 이어가야 합니다.",
        immediate_next_step: "파일을 변경한 뒤 다음 블록에서 검증합니다.",
      });
    },
    runFunctionToolPromptText: async (input) => {
      toolPromptCalls += 1;
      budgetStates.push(input.usageAttribution?.getBudgetState?.() ?? {});
      input.usageAttribution?.beforeModelRequest?.({ roundIndex: 0 });
      if (toolPromptCalls === 1) {
        await input.executeTool({
          name: "update_todo_list",
          args: { todos: checkpointPlan },
          rawArguments: JSON.stringify({ todos: checkpointPlan }),
        });
        await input.executeTool({
          name: "write_file",
          args: { path: "checkpoint-proof.txt", content: "changed" },
          rawArguments: JSON.stringify({ path: "checkpoint-proof.txt", content: "changed" }),
        });
        throw promptUsageModelCallBudgetExhaustedError();
      }
      expect(input.prompt).toContain("## Resumed Typed Turn Contract");
      expect(input.prompt).toContain("Recent Round Journal");
      expect(workBlockCatalogNames(input.dynamicTools?.() ?? input.tools)).toEqual(expect.arrayContaining([
        "write_file",
        "run_command",
      ]));
      const call = {
        name: "run_command",
        args: { command: "bun test checkpoint-proof", validation_suite: "checkpoint-proof" },
      };
      await input.onAssistantTextBeforeTools?.({
        text: [
          "title: 체크포인트 변경 검증",
          "summary: 이전 블록에서 변경한 파일을 검증합니다.",
          "rationale: 저장된 code_change 증거에 validation 증거를 더해야 계약이 완료됩니다.",
          "next_step: 검증이 통과하면 같은 계약의 최종 결과를 보고합니다.",
        ].join("\n"),
        toolCalls: [call],
      });
      await input.executeTool({ ...call, rawArguments: JSON.stringify(call.args) });
      await input.executeTool({
        name: "update_todo_list",
        args: {
          title: "체크포인트 재개 검증",
          todos: checkpointPlan.map((todo) => todo.id === "report"
            ? todo
            : { ...todo, status: "completed" as const }),
        },
        rawArguments: JSON.stringify({ todos: checkpointPlan }),
      });
      for (let index = 0; index <= WORKSPACE_INSPECTION_MAX_CONSECUTIVE_READS; index += 1) {
        const read = {
          name: "read_file",
          args: { path: `closeout-evidence-${index}.txt` },
        };
        await input.executeTool({ ...read, rawArguments: JSON.stringify(read.args) });
      }
      expect(workBlockCatalogNames(input.dynamicTools?.() ?? input.tools)).toContain("read_file");
      return "같은 계약에서 파일 변경과 검증을 완료했습니다.";
    },
    executeButlerTool: async (call) => {
      if (call.name === "read_file") return { ok: true, content: "closeout evidence" };
      return {
        ok: true,
        evidence_capability_receipts: [call.name === "write_file"
          ? createEvidenceCapabilityReceipt({
            producer: { kind: "tool", name: "write_file" },
            capability: "workspace_mutated",
            evidence_kind: "mutation_result",
            summary: "Checkpoint fixture was written.",
          })
          : createEvidenceCapabilityReceipt({
            producer: { kind: "tool", name: "run_command" },
            capability: "validation_passed",
            evidence_kind: "execution_result",
            summary: "Checkpoint validation passed.",
          })],
      };
    },
  });
  const handle = await runtime.createSession({
    sessionId,
    role: "butler",
    workspacePath: data,
    systemPrompt: "You are Sandy.",
    metadata: { projectId: "butler" },
  });
  const baseTurn = {
    handle,
    provider: typedProvider,
    model: "openai/gpt-5.5" as const,
    input: { text: "파일을 변경하고 검증까지 완료해줘." },
    emitTurnEvent: (event: RuntimeTurnEventInput) => {
      events.push(event);
    },
  };
  let yielded: unknown;
  try {
    await runtime.runTurn({
      ...baseTurn,
      metadata: { turnId, runtimePolicy: { completionReview: "disabled" } },
    });
  } catch (error) {
    yielded = error;
  }
  expect(isTurnSchedulerContinuationYieldError(yielded)).toBe(true);
  const atom = readTurnContextAtom({ butlerData: data, sessionId, turnId });
  expect(atom).toMatchObject({
    generation: 1,
    contractId: expect.stringContaining("contract-"),
    workStreamId: expect.stringContaining("work-contract-"),
    nextSemanticBlockSequence: 1,
    budgetSnapshot: { modelRequestsUsed: 1 },
    roundJournal: expect.arrayContaining([
      expect.objectContaining({ tool: "write_file", observed_delta: "mutation" }),
    ]),
    obligationFrontier: expect.objectContaining({
      stage: "workspace_execution",
      workspaceMutationObserved: true,
      validationObserved: false,
      validationFocused: false,
    }),
  });

  const result = await runtime.runTurn({
    ...baseTurn,
    metadata: {
      turnId,
      runtimePolicy: { completionReview: "disabled" },
      schedulerContinuation: {
        contextAtomId: createTurnContextAtomId(sessionId, turnId),
        checkpointId: atom!.checkpointId,
        schedulerItemId: "queue-continuation-1",
      },
    },
  });

  expect(result.text).toContain("완료했습니다");
  expect(typedDecisionCalls).toBe(1);
  expect(toolPromptCalls).toBe(2);
  expect(budgetStates).toEqual([
    expect.objectContaining({ requestCount: 0, cumulativeRequestCount: 0 }),
    expect.objectContaining({ requestCount: 0, cumulativeRequestCount: 1 }),
  ]);
  expect(events.filter((event) => event.kind === "assistant.decision")).toHaveLength(1);
  expect(events.filter((event) => event.kind === "turn.first_progress")).toHaveLength(1);
  expect(events.filter((event) => event.kind === "turn.continuation_scheduled")).toHaveLength(1);
  expect(events.find((event) => event.kind === "turn.continuation_scheduled")?.payload)
    .toMatchObject({
      checkpointId: atom!.checkpointId,
      schedulerItemId: "queue-continuation-1",
    });
  const blockIds = events
    .filter((event) => event.kind === "work.block.started")
    .map((event) => String((event.payload as Record<string, unknown>).semanticBlockId));
  expect(blockIds).toEqual([
    expect.stringContaining(":block:0"),
    expect.stringContaining(":block:1"),
  ]);
  expect(new Set(blockIds).size).toBe(blockIds.length);
  expect(readTurnContextAtom({ butlerData: data, sessionId, turnId })).toBeNull();
});

function decisionIdFromFormat(format: { schema: Record<string, unknown> } | undefined): string {
  const value = format?.schema && typeof format.schema === "object"
    ? (format.schema as { properties?: { decision_id?: { const?: unknown } } }).properties?.decision_id?.const
    : null;
  if (typeof value !== "string") throw new Error("decision id missing from response format");
  return value;
}

function testWorkBlock(
  blockTitle: string,
  name: string,
  args: Record<string, unknown>,
) {
  return {
    name: "run_work_block",
    args: {
      decision: {
        block_title: blockTitle,
        objective: `${blockTitle} 단계의 구조화된 작업을 실행합니다.`,
        rationale: "현재 obligation frontier가 이 단계의 증거를 요구합니다.",
        next_step: "관찰된 결과를 바탕으로 다음 frontier 단계로 이동합니다.",
        expected_effect: `${blockTitle} 결과가 현재 계약에 기록됩니다.`,
        repeat_reason: null,
        completion_obligations: [],
      },
      calls: [{ name, args }],
    },
  };
}

function workBlockCatalogNames(
  tools: readonly { name: string; description?: string; parameters: Record<string, unknown> }[],
): string[] {
  const wrapper = tools.find((tool) => tool.name === "run_work_block");
  if (!wrapper) return tools.map((tool) => tool.name);
  const items = (wrapper.parameters.properties as Record<string, any> | undefined)
    ?.calls?.items as Record<string, any> | undefined;
  const variants = (items?.oneOf ?? (items ? [items] : [])) as Array<Record<string, any>>;
  const names = variants.flatMap((variant) => {
    const name = variant.properties?.name?.const;
    return typeof name === "string" ? [name] : [];
  });
  if (names.length > 0) return names;
  const available = wrapper.description?.match(/Available calls: ([^.]+)\./u)?.[1];
  return available ? available.split(",").map((name) => name.trim()).filter(Boolean) : [];
}

function decisionIdFromToolParameters(parameters: Record<string, unknown>): string {
  const value = (parameters as {
    properties?: { decision_id?: { const?: unknown } };
  }).properties?.decision_id?.const;
  if (typeof value !== "string") throw new Error("decision id missing from tool parameters");
  return value;
}

function readOnlyContract(): Record<string, unknown> {
  const dir = join(data, "turn-contracts");
  const file = readdirSync(dir).find((name) => name.endsWith(".json"));
  if (!file) throw new Error("turn contract missing");
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
}
