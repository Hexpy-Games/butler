import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { createEvidenceCapabilityReceipt } from "../../packages/butler-agent/src/agent/output/evidence/parser.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import type { RuntimeTurnEventInput } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { operationalMetricsPath } from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";

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
    model: "openai/gpt-5.5",
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
      deliverables: ["status_report"],
      answer_text: null,
      public_summary: "현재 프로젝트 상태를 확인해야 정확히 답할 수 있습니다.",
      immediate_next_step: "Project Ledger 상태를 먼저 조회합니다.",
    }),
    runFunctionToolPromptText: async (input) => {
      selectedTools = input.tools.map((tool) => tool.name);
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
  expect(selectedTools).toContain("project_ledger_status");
  expect(selectedTools).not.toContain("project_ledger_create");
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

test("workspace inspect exposes direct read tools without mutation tools", async () => {
  let selectedTools: string[] = [];
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
      deliverables: ["status_report"],
      answer_text: null,
      public_summary: "저장소 설정을 기존 소스에서 확인해야 합니다.",
      immediate_next_step: "관련 설정명을 좁게 검색합니다.",
    }),
    runFunctionToolPromptText: async (input) => {
      selectedTools = input.tools.map((tool) => tool.name);
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
  expect(selectedTools).toContain("grep_files");
  expect(selectedTools).toContain("read_file");
  expect(selectedTools).not.toContain("write_file");
  expect(readOnlyContract()).toMatchObject({ action: "inspect", state: "delivered" });
});

test("workspace search candidates continue into source verification before delivery", async () => {
  const toolPrompts: string[] = [];
  const executedTools: string[] = [];
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
      deliverables: ["status_report"],
      answer_text: null,
      public_summary: "실제 소스에서 캐시 설정 파일과 함수명을 확인해야 합니다.",
      immediate_next_step: "관련 키워드로 후보 파일을 검색합니다.",
    }),
    runFunctionToolPromptText: async (input) => {
      toolPrompts.push(input.prompt);
      const name = toolPrompts.length === 1 ? "grep_files" : "read_file";
      const args = name === "grep_files"
        ? { pattern: "prompt_cache" }
        : { path: "packages/butler-agent/src/integrations/providers/provider.ts" };
      await input.executeTool({ name, args, rawArguments: JSON.stringify(args) });
      return name === "grep_files"
        ? "후보 파일을 찾았지만 아직 소스를 검증하지 않았습니다."
        : "provider.ts를 읽어 캐시 설정 함수를 확인했습니다.";
    },
    executeButlerTool: async (call) => {
      executedTools.push(call.name);
      return {
        ok: true,
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
  expect(toolPrompts).toHaveLength(2);
  expect(toolPrompts[1]).toContain("Current user request: 캐시 설정 파일과 함수명을 실제 소스에서 확인해줘.");
  expect(toolPrompts[1]).toContain("typed turn contract is not complete");
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
      expect(input.tools.map((tool) => tool.name)).toContain("project_ledger_status");
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

test("one semantic decision block closes only after its final tool", async () => {
  const events: RuntimeTurnEventInput[] = [];
  let selectedTools: string[] = [];
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
      selectedTools = input.tools.map((tool) => tool.name);
      const toolCalls = [
        { name: "write_file", args: { path: "fixture.txt", content: "done" } },
        { name: "run_command", args: { command: "bun test fixture" } },
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
  expect(selectedTools).toContain("write_file");
  expect(selectedTools).not.toContain("project_ledger_create");
  const blockEvents = events.filter((event) => event.kind.startsWith("work.block."));
  expect(blockEvents.map((event) => event.kind)).toEqual(["work.block.started", "work.block.completed"]);
  expect(new Set(blockEvents.map((event) => (event.payload as Record<string, unknown>).workBlockId)).size).toBe(1);
  const firstToolCompleted = events.findIndex((event) => event.kind === "tool.completed");
  const blockCompleted = events.findIndex((event) => event.kind === "work.block.completed");
  expect(blockCompleted).toBeGreaterThan(firstToolCompleted);
  expect(readOnlyContract()).toMatchObject({
    action: "start_work",
    deliverables: ["code_change", "validation", "final_report"],
    state: "delivered",
  });
});

function decisionIdFromFormat(format: { schema: Record<string, unknown> } | undefined): string {
  const value = format?.schema && typeof format.schema === "object"
    ? (format.schema as { properties?: { decision_id?: { const?: unknown } } }).properties?.decision_id?.const
    : null;
  if (typeof value !== "string") throw new Error("decision id missing from response format");
  return value;
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
