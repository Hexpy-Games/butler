import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ToolSurfacePromptController } from "../../packages/butler-agent/src/agent/turn/tool-surface-prompt-controller.ts";
import { TurnContractStore } from "../../packages/butler-agent/src/agent/turn/turn-contract.ts";
import { runTypedTurnEntry } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/typed-turn-entry.ts";
import { TurnContractSurfaceInconsistentError } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/turn-contract-surface-invariant.ts";
import type { ActiveTurnContract } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/turn-contract-runtime.ts";
import type { RuntimeTurnInput } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { createNativeTurnPromptRunners } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/turn-prompt-runners.ts";
import { createDirectTurnBudget } from "../../packages/butler-agent/src/agent/turn/direct-turn-budget.ts";
import {
  compileStructuredTurnDecision,
  parseStructuredTurnDecision,
} from "../../packages/butler-agent/src/agent/turn/native/turn-runner/typed-turn-decision.ts";
import { safeRuntimeFailure } from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";

const tempDirs: string[] = [];
afterEach(() => tempDirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

test("provider tool runner is never invoked with an empty obligation surface", async () => {
  const butlerData = tempData();
  const turnInput = runtimeTurnInput();
  let providerStarts = 0;
  const decision = toolAnswerDecision("decision-empty-provider-surface");
  const parsedDecision = parseStructuredTurnDecision(JSON.stringify(decision), decision.decision_id);
  const contract = compileStructuredTurnDecision({
    decision: parsedDecision,
    candidates: {},
    workspaceId: "butler/general-chat",
  });
  const toolSurfaceController = new ToolSurfacePromptController({
    role: "butler",
    message: "원래 사용자 요청",
    tools: [],
    providerSupportsSchemaPromotion: false,
  });
  const runners = createNativeTurnPromptRunners({
    turnInput,
    session: { init: {
      sessionId: "butler/general-chat",
      role: "butler",
      workspacePath: butlerData,
      systemPrompt: "You are Butler.",
    } },
    deps: {
      runtimeId: "native",
      promptRunner: async () => "",
      toolPromptRunner: async () => {
        providerStarts += 1;
        return "";
      },
      butlerHome: butlerData,
      butlerData,
      messageLanguage: "ko",
      automaticRecallEnabled: false,
      runAutomaticRecall: async ({ cue }) => ({ cue, seeds: [], items: [], abstained: true, diagnostics: [] }),
    },
    turnId: "turn-provider-surface",
    turnBudget: createDirectTurnBudget("turn-provider-surface"),
    promptSections: [],
    attachments: [],
    executor: async () => ({}),
    toolSurfaceController,
    plannedReview: null,
    publicDecisionContext: [],
    pendingPublicDecisions: [],
    markAssistantTextBeforeToolsSeen: () => {},
    turnContractContext: { current: {
      contract,
      decision: parsedDecision,
      publicDecision: {
        decisionId: decision.decision_id,
        contractId: contract.contract_id,
        summary: decision.public_summary,
        evidenceRefs: [],
        source: "model-authored",
      },
    } },
  });

  await expect(runners.runToolPrompt("execute contract")).rejects.toMatchObject({
    code: "turn_contract_surface_inconsistent",
  });
  expect(providerStarts).toBe(0);
});

test("empty read-only contract surface gets one typed redecision before provider tools start", async () => {
  const butlerData = tempData();
  const prompts: string[] = [];
  let toolPromptStarts = 0;
  const turnContractContext: { current: ActiveTurnContract | null } = { current: null };
  const result = await runTypedTurnEntry({
    ...entryInput(butlerData, turnContractContext),
    runPrivateTextPrompt: async (prompt, _phase, _sections, responseFormat) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? JSON.stringify(toolAnswerDecision(decisionId(responseFormat)))
        : JSON.stringify(answerDecision(decisionId(responseFormat)));
    },
    runKernelToolPrompt: async () => {
      toolPromptStarts += 1;
      const contract = turnContractContext.current!.contract;
      throw new TurnContractSurfaceInconsistentError(
        contract.contract_id,
        contract.required_evidence.map((item) => item.obligation_id),
      );
    },
  });

  expect(result.activeTurnContract.contract.action).toBe("answer");
  expect(result.candidateText).toBe("직접 답변입니다.");
  expect(toolPromptStarts).toBe(1);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("## Structural Contract Diagnostic");
  expect(prompts[1]).toContain("원래 사용자 요청");
  const contracts = storedContracts(butlerData);
  expect(contracts.map((contract) => contract.state).sort()).toEqual(["failed_system", "satisfied"]);
  expect(contracts.map((contract) => contract.decision_id)).toHaveLength(2);
});

test("a repeated empty surface fails the second contract without a loop", async () => {
  const butlerData = tempData();
  let decisionCalls = 0;
  let toolPromptStarts = 0;
  const turnContractContext: { current: ActiveTurnContract | null } = { current: null };
  let repeatedError: unknown;
  try {
    await runTypedTurnEntry({
      ...entryInput(butlerData, turnContractContext),
      runPrivateTextPrompt: async (_prompt, _phase, _sections, responseFormat) => {
        decisionCalls += 1;
        return JSON.stringify(toolAnswerDecision(decisionId(responseFormat)));
      },
      runKernelToolPrompt: async () => {
        toolPromptStarts += 1;
        const contract = turnContractContext.current!.contract;
        throw new TurnContractSurfaceInconsistentError(
          contract.contract_id,
          contract.required_evidence.map((item) => item.obligation_id),
        );
      },
    });
  } catch (error) {
    repeatedError = error;
  }

  expect(repeatedError).toMatchObject({ code: "turn_contract_surface_inconsistent", retryable: true });
  expect(safeRuntimeFailure(repeatedError)).toMatchObject({
    code: "turn_contract_surface_inconsistent",
    retryable: true,
    message: "Butler could not create a valid tool path for this request. Retry the turn.",
  });
  expect(decisionCalls).toBe(2);
  expect(toolPromptStarts).toBe(2);
  expect(storedContracts(butlerData).map((contract) => contract.state)).toEqual([
    "failed_system",
    "failed_system",
  ]);
});

function entryInput(
  butlerData: string,
  turnContractContext: { current: ActiveTurnContract | null },
) {
  const turnInput = runtimeTurnInput();
  return {
    turnInput,
    session: {
      init: {
        sessionId: "butler/general-chat",
        role: "butler" as const,
        workspacePath: butlerData,
        systemPrompt: "You are Butler.",
      },
    },
    butlerData,
    context: {
      turnId: "turn-surface-recovery",
      chatId: "general-chat",
      prompt: "Current user instruction:\n원래 사용자 요청",
      userText: "원래 사용자 요청",
      promptSections: [],
      plannedReview: null,
      resumeSelection: { candidates: [], blockers: [] },
      toolSurfaceController: new ToolSurfacePromptController({
        role: "butler",
        message: "원래 사용자 요청",
        tools: [],
        providerSupportsSchemaPromotion: false,
      }),
    },
    initialPromptPhase: "initial_tool_loop",
    pendingPublicDecisions: [],
    turnContractContext,
    runPrivateFunctionDecisionPrompt: async () => {
      throw new Error("function transport must not run");
    },
  };
}

function runtimeTurnInput(): RuntimeTurnInput {
  return {
    handle: { sessionId: "butler/general-chat", role: "butler", runtimeAdapterId: "native" },
    provider: {
      id: "structured-test",
      capabilities: {
        supportsStreaming: false,
        supportsToolCalls: true,
        supportsImages: false,
        supportsAudio: false,
        supportsServerThreads: false,
        supportsReasoningConfig: true,
        supportsPromptCaching: false,
        supportsStructuredOutputs: true,
        structuredDecisionTransport: "json_schema",
      },
      invoke: async () => ({ text: "" }),
    },
    model: "openai/test",
    input: { text: "원래 사용자 요청" },
  };
}

function toolAnswerDecision(decisionIdValue: string) {
  return {
    schema_version: "butler.turn-contract-decision.v1",
    decision_id: decisionIdValue,
    action: "tool_answer",
    evidence_domain: "public_web",
    inspection_scope: null,
    target_workstream_id: null,
    target_project_id: null,
    blocker_id: null,
    deliverables: ["grounded_answer"],
    answer_text: null,
    public_title: "공개 근거 확인",
    public_summary: "공개 근거를 확인합니다.",
    public_rationale: "도구가 필요한 요청입니다.",
    immediate_next_step: "공개 근거를 조회합니다.",
  };
}

function answerDecision(decisionIdValue: string) {
  return {
    schema_version: "butler.turn-contract-decision.v1",
    decision_id: decisionIdValue,
    action: "answer",
    evidence_domain: null,
    inspection_scope: null,
    target_workstream_id: null,
    target_project_id: null,
    blocker_id: null,
    deliverables: [],
    answer_text: "직접 답변입니다.",
    public_title: null,
    public_summary: "직접 답변합니다.",
    public_rationale: null,
    immediate_next_step: null,
  };
}

function decisionId(responseFormat: { schema: Record<string, unknown> }): string {
  const schema = responseFormat.schema as { properties?: { decision_id?: { const?: unknown } } };
  const value = schema.properties?.decision_id?.const;
  if (typeof value !== "string") throw new Error("decision id missing");
  return value;
}

function storedContracts(butlerData: string): Array<{ state: string; decision_id: string }> {
  const store = new TurnContractStore(butlerData);
  return readdirSync(join(butlerData, "turn-contracts"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => store.read(name.slice(0, -5))!)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function tempData(): string {
  const path = mkdtempSync(join(tmpdir(), "butler-turn-surface-"));
  tempDirs.push(path);
  return path;
}
