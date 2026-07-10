import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

test("seventy tool rounds survive two process restarts without losing contract progress", async () => {
  const turnId = "turn-seventy-rounds";
  const sessionId = "butler/seventy-rounds";
  const events: RuntimeTurnEventInput[] = [];
  const cumulativeBudgetBeforeRequest: number[] = [];
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
          cumulativeBudgetBeforeRequest.push(budget?.cumulativeRequestCount ?? -1);
          windowBudgetBeforeRequest.push(budget?.requestCount ?? -1);
          input.usageAttribution?.beforeModelRequest?.({
            roundIndex: step - segmentStart - 1,
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
    budgetSnapshot: { modelRequestsUsed: 24 },
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
    nextSemanticBlockSequence: 48,
    budgetSnapshot: { modelRequestsUsed: 48 },
  });
  expect(secondAtom?.roundJournal).toHaveLength(48);

  const result = await runProcess({
    contextAtomId: createTurnContextAtomId(sessionId, turnId),
    checkpointId: secondAtom!.checkpointId,
    schedulerItemId: "queue-longevity-2",
  });

  expect(result.text).toContain("완료했습니다");
  expect(processStarts).toBe(3);
  expect(typedDecisionCalls).toBe(1);
  expect(completedRounds).toBe(70);
  expect(cumulativeBudgetBeforeRequest).toEqual(
    Array.from({ length: 70 }, (_, index) => index),
  );
  expect(windowBudgetBeforeRequest.slice(0, 24)).toEqual(
    Array.from({ length: 24 }, (_, index) => index),
  );
  expect(windowBudgetBeforeRequest.slice(24, 48)).toEqual(
    Array.from({ length: 24 }, (_, index) => index),
  );
  expect(windowBudgetBeforeRequest.slice(48)).toEqual(
    Array.from({ length: 22 }, (_, index) => index),
  );
  expect(prompts).toHaveLength(3);
  expect(prompts[1]).toContain("## Resumed Typed Turn Contract");
  expect(prompts[2]).toContain("## Resumed Typed Turn Contract");
  expect(prompts[2]).toContain('"sequence": 31');
  expect(prompts[2]).not.toContain('"sequence": 30');
  expect(events.filter((event) =>
    event.kind === "assistant.decision" && event.payload?.role === "opening",
  )).toHaveLength(1);
  expect(events.filter((event) => event.kind === "turn.continuation_scheduled")).toHaveLength(2);
  const startedSequences = events
    .filter((event) => event.kind === "work.block.started")
    .map((event) => semanticBlockSequence(event.payload?.semanticBlockId));
  expect(startedSequences).toEqual(Array.from({ length: 70 }, (_, index) => index));
  expect(events.filter((event) => event.kind === "work.block.completed")).toHaveLength(70);
  expect(readTurnContextAtom({ butlerData: data, sessionId, turnId })).toBeNull();
  expect(readOnlyContract()).toMatchObject({
    contract_id: firstAtom!.contractId,
    target_workstream_id: firstAtom!.workStreamId,
    state: "delivered",
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

function readOnlyContract(): Record<string, unknown> {
  const dir = join(data, "turn-contracts");
  const file = readdirSync(dir).find((name) => name.endsWith(".json"));
  if (!file) throw new Error("turn contract missing");
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
}
