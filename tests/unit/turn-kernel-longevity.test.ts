import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvidenceCapabilityReceipt } from "../../packages/butler-agent/src/agent/output/evidence/parser.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import {
  createTurnContextAtomId,
  isTurnSchedulerContinuationYieldError,
  readTurnContextAtom,
} from "../../packages/butler-agent/src/agent/turn/turn-continuation-context.ts";
import { promptUsageModelCallBudgetExhaustedError } from "../../packages/butler-agent/src/integrations/providers/shared/usage.ts";
import type {
  ModelProviderAdapter,
  RuntimeTurnEventInput,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

let data = "";

beforeEach(() => {
  data = join(tmpdir(), `butler-turn-longevity-${Date.now()}-${Math.random()}`);
  mkdirSync(data, { recursive: true });
});

afterEach(() => rmSync(data, { recursive: true, force: true }));

const provider: ModelProviderAdapter = {
  id: "longevity-provider",
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

test("logical-turn spend cannot reset across restart and preserves recoverable contract progress", async () => {
  const turnId = "turn-seventy-rounds";
  const sessionId = "butler/seventy-rounds";
  const events: RuntimeTurnEventInput[] = [];
  const windowBudgetBeforeRequest: number[] = [];
  const prompts: string[] = [];
  let typedDecisionCalls = 0;
  let completedRounds = 0;
  let processStarts = 0;

  const createRuntime = () => {
    processStarts += 1;
    return new NativeToolLoopRuntime({
      butlerData: data,
      butlerHome: process.cwd(),
      disableAutomaticRecall: true,
      runPromptText: async (input) => {
        if (input.usageAttribution?.phase === "budget_exhaustion_finalization") {
          const roundIndex = input.usageAttribution.roundIndex ?? 0;
          input.usageAttribution.beforeModelRequest?.({ roundIndex });
          input.usageAttribution.beforeAdmittedModelRequest?.({
            roundIndex,
            phase: input.usageAttribution.phase,
            admittedPromptTokens: 100,
            requestedOutputTokens: input.usageAttribution.requestedOutputTokens ?? 0,
            requestHash: `finalization-${roundIndex}`,
          });
          return "24개 증거 라운드까지 보존했지만 실행 예산이 소진되어 나머지 작업은 이어서 진행해야 합니다.";
        }
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
          public_title: "70라운드 지속 실행",
          public_summary: "하나의 계약에서 70개 증거 라운드를 순서대로 완료합니다.",
          public_rationale: "두 번 재시작해도 결정과 도구 관찰을 잃지 않아야 합니다.",
          immediate_next_step: "첫 번째 증거 파일부터 기록합니다.",
        });
      },
      runFunctionToolPromptText: async (input) => {
        prompts.push(input.prompt);
        const segmentStart = completedRounds;
        const segmentEnd = segmentStart < 48 ? segmentStart + 24 : 70;
        expect(segmentEnd - segmentStart).toBeLessThanOrEqual(input.maxToolRounds ?? 0);
        while (completedRounds < segmentEnd) {
          const step = completedRounds + 1;
          const budget = input.usageAttribution?.getBudgetState?.();
          windowBudgetBeforeRequest.push(budget?.requestCount ?? -1);
          input.usageAttribution?.beforeModelRequest?.({
            roundIndex: step - segmentStart - 1,
          });
          input.usageAttribution?.beforeAdmittedModelRequest?.({
            roundIndex: step - segmentStart - 1,
            phase: input.usageAttribution.phase,
            admittedPromptTokens: 100,
            requestedOutputTokens: input.usageAttribution.requestedOutputTokens ?? 0,
            requestHash: `execution-${step}`,
          });
          const call = step === 70
            ? { name: "run_command", args: { command: "bun test longevity-proof" } }
            : {
              name: "write_file",
              args: {
                path: `longevity/round-${String(step).padStart(2, "0")}.txt`,
                content: `round ${step}`,
              },
            };
          await input.onAssistantTextBeforeTools?.({
            text: [
              `title: 증거 라운드 ${step}`,
              `summary: ${step}번째 증거를 현재 계약에 추가합니다.`,
              "rationale: 직전 결과를 보존한 상태에서 다음 작은 단계를 진행해야 합니다.",
              `next_step: ${step === 70 ? "검증 결과로 계약을 완료합니다." : `${step + 1}번째 증거를 확인합니다.`}`,
            ].join("\n"),
            toolCalls: [call],
          });
          if (step === 70) {
            await input.executeTool({
              name: "update_todo_list",
              args: {
                list_id: "main",
                title: "70라운드 지속 실행",
                todos: [{
                  id: "longevity",
                  content: "70개 증거 라운드를 순서대로 완료합니다.",
                  active_form: "증거 라운드를 실행하고 있습니다.",
                  status: "completed",
                  phase: "execution",
                }],
              },
              rawArguments: JSON.stringify({ list_id: "main" }),
            });
          }
          await input.executeTool({
            ...call,
            rawArguments: JSON.stringify(call.args),
          });
          completedRounds = step;
        }
        if (completedRounds === 24 || completedRounds === 48) {
          throw promptUsageModelCallBudgetExhaustedError();
        }
        return "70개 라운드와 최종 검증을 같은 계약에서 완료했습니다.";
      },
      executeButlerTool: async (call) => ({
        ok: true,
        state_revision: `revision-${completedRounds + 1}`,
        evidence_capability_receipts: call.name === "run_command"
          ? [createEvidenceCapabilityReceipt({
            producer: { kind: "tool", name: "run_command" },
            capability: "validation_passed",
            evidence_kind: "execution_result",
            summary: "The deterministic longevity validation passed.",
          })]
          : call.name === "write_file"
            ? [createEvidenceCapabilityReceipt({
              producer: { kind: "tool", name: "write_file" },
              capability: "workspace_mutated",
              evidence_kind: "mutation_result",
              summary: "A deterministic longevity evidence file was written.",
            })]
            : [],
      }),
    });
  };

  const runProcess = async (schedulerContinuation?: {
    contextAtomId: string;
    checkpointId: string;
    schedulerItemId: string;
  }) => {
    const runtime = createRuntime();
    const handle = await runtime.createSession({
      sessionId,
      role: "butler",
      workspacePath: data,
      systemPrompt: "You are Sandy. Continue until the contract is complete.",
      metadata: { projectId: "butler" },
    });
    return await runtime.runTurn({
      handle,
      provider,
      model: "openai/gpt-5.5",
      input: { text: "70개 증거 라운드를 중단 없이 완료해줘." },
      metadata: {
        turnId,
        runtimePolicy: { completionReview: "disabled" },
        ...(schedulerContinuation ? { schedulerContinuation } : {}),
      },
      emitTurnEvent: (event) => {
        events.push(event);
      },
    });
  };

  let firstYield: unknown;
  try {
    await runProcess();
  } catch (error) {
    firstYield = error;
  }
  expect(isTurnSchedulerContinuationYieldError(firstYield)).toBe(true);
  const firstAtom = readTurnContextAtom({ butlerData: data, sessionId, turnId });
  expect(firstAtom).toMatchObject({
    generation: 1,
    nextSemanticBlockSequence: 24,
    budgetSnapshot: {
      modelRequestsUsed: 28,
      partitions: {
        execution: { modelRequestsUsed: 24 },
        finalization: { modelRequestsUsed: 4 },
      },
    },
  });
  expect(firstAtom?.roundJournal).toHaveLength(24);

  let secondYield: unknown;
  try {
    await runProcess({
      contextAtomId: createTurnContextAtomId(sessionId, turnId),
      checkpointId: firstAtom!.checkpointId,
      schedulerItemId: "queue-longevity-1",
    });
  } catch (error) {
    secondYield = error;
  }
  expect(isTurnSchedulerContinuationYieldError(secondYield)).toBe(true);
  const secondAtom = readTurnContextAtom({ butlerData: data, sessionId, turnId });
  expect(secondAtom).toMatchObject({
    generation: 2,
    contractId: firstAtom!.contractId,
    workStreamId: firstAtom!.workStreamId,
    nextSemanticBlockSequence: 24,
    budgetSnapshot: { modelRequestsUsed: 28 },
  });
  expect(secondAtom?.roundJournal).toHaveLength(24);
  expect(processStarts).toBe(2);
  expect(typedDecisionCalls).toBe(1);
  expect(completedRounds).toBe(24);
  expect(windowBudgetBeforeRequest.slice(0, 24)).toEqual(
    Array.from({ length: 24 }, (_, index) => index),
  );
  expect(windowBudgetBeforeRequest.slice(24)).toHaveLength(5);
  expect(windowBudgetBeforeRequest.slice(24).every((value) => value === 24)).toBe(true);
  expect(prompts).toHaveLength(6);
  expect(prompts.some((prompt) => prompt.includes("## Resumed Typed Turn Contract"))).toBe(true);
  expect(events.filter((event) =>
    event.kind === "assistant.decision" && event.payload?.role === "opening",
  )).toHaveLength(1);
  expect(events.filter((event) => event.kind === "turn.continuation_scheduled")).toHaveLength(1);
  const startedSequences = events
    .filter((event) => event.kind === "work.block.started")
    .map((event) => semanticBlockSequence(event.payload?.semanticBlockId));
  expect(startedSequences).toEqual(Array.from({ length: 24 }, (_, index) => index));
  expect(events.filter((event) => event.kind === "work.block.completed")).toHaveLength(24);
  expect(readTurnContextAtom({ butlerData: data, sessionId, turnId })).not.toBeNull();
  expect(secondAtom).toMatchObject({
    contractId: firstAtom!.contractId,
    sourceErrorCode: "prompt_usage_model_call_budget_exhausted",
  });
});

function decisionIdFromFormat(format: { schema: Record<string, unknown> } | undefined): string {
  const value = format?.schema && typeof format.schema === "object"
    ? (format.schema as { properties?: { decision_id?: { const?: unknown } } })
      .properties?.decision_id?.const
    : null;
  if (typeof value !== "string") throw new Error("decision id missing from response format");
  return value;
}

function semanticBlockSequence(value: unknown): number {
  const match = typeof value === "string" ? value.match(/:block:(\d+)$/u) : null;
  if (!match) throw new Error(`semantic block sequence missing: ${String(value)}`);
  return Number(match[1]);
}
