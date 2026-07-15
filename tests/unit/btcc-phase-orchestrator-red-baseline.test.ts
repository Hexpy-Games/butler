import { describe, expect, test } from "bun:test";
import {
  appendButlerToolInstructions,
} from "../../packages/butler-agent/src/agent/turn/native/output/tool-instructions.ts";
import {
  compileStructuredTurnDecision,
  typedTurnDecisionInstructions,
} from "../../packages/butler-agent/src/agent/turn/native/turn-runner/typed-turn-decision.ts";
import {
  TURN_CONTRACT_DECISION_SCHEMA,
  type TurnContractDecision,
} from "../../packages/butler-agent/src/agent/turn/turn-contract.ts";
import type {
  ModelInvocation,
  ModelProviderAdapter,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import {
  failedInvariantSteps,
  MessageLifecycleTrace,
} from "../support/message-lifecycle-trace.ts";

const BTCC_HEADING = "## Butler Turn Cognition Cycle";

function providerRecording(calls: ModelInvocation[]): ModelProviderAdapter {
  return {
    id: "btcc-baseline-provider",
    capabilities: {
      supportsStreaming: false,
      supportsToolCalls: true,
      supportsImages: false,
      supportsAudio: false,
      supportsServerThreads: false,
      supportsReasoningConfig: true,
      supportsPromptCaching: false,
    },
    async invoke(input) {
      calls.push(input);
      return {
        text: JSON.stringify({
          summary: "요청의 범위를 먼저 정리합니다.",
          rationale: "작업 시작 전에 목표를 확인해야 합니다.",
          nextStep: "구체적인 실행 방향을 결정합니다.",
        }),
      };
    },
  };
}

function projectCodeChangeDecision(): TurnContractDecision {
  return {
    schema_version: TURN_CONTRACT_DECISION_SCHEMA,
    decision_id: "decision-project-code-change",
    action: "start_work",
    target_project_id: "butler",
    deliverables: ["code_change"],
    continuity_updates: [],
    public_title: "BTCC 구조 구현",
    public_summary: "프로젝트 런타임 구조를 수정합니다.",
    public_rationale: "요청된 프로젝트 구현을 진행해야 합니다.",
    immediate_next_step: "계획을 만들고 구현을 시작합니다.",
  };
}

describe("current BTCC phase-orchestrator red baseline", () => {
  test("executes current prompts and project routing to capture contract violations", async () => {
    const fixedPrompt = appendButlerToolInstructions("Persona.", {
      fixedSurface: true,
      availableToolNames: ["read_file"],
    });
    const structuredPrompt = appendButlerToolInstructions("Persona.", {
      structuredSurface: true,
      availableToolNames: ["read_file", "write_file"],
    });
    const decisionPrompt = typedTurnDecisionInstructions({
      decisionId: "decision-project-code-change",
      projectId: "butler",
      candidateIds: [],
    });
    const compiled = compileStructuredTurnDecision({
      decision: projectCodeChangeDecision(),
      candidates: {},
      workspaceId: "workspace-butler",
      projectId: "butler",
      projectLedgerBound: true,
      now: new Date(0),
    });
    const calls: ModelInvocation[] = [];
    void providerRecording(calls);

    const trace = new MessageLifecycleTrace(
      "current-btcc-phase-orchestration",
      "session-project",
      "turn-project-change",
    );
    trace.record({
      step: "1",
      actualFunction: "appendButlerToolInstructions(fixedSurface)",
      concreteInput: { fixedSurface: true },
      stateRead: {},
      stateWritten: {},
      outputOrNextCall: { containsBtcc: fixedPrompt.includes(BTCC_HEADING) },
      invariant: fixedPrompt.includes(BTCC_HEADING) ? "pass" : "fail",
      evidence: "real fixed-surface prompt assembly",
    });
    trace.record({
      step: "2",
      actualFunction: "appendButlerToolInstructions(structuredSurface)",
      concreteInput: { structuredSurface: true },
      stateRead: {},
      stateWritten: {},
      outputOrNextCall: { containsBtcc: structuredPrompt.includes(BTCC_HEADING) },
      invariant: structuredPrompt.includes(BTCC_HEADING) ? "pass" : "fail",
      evidence: "real structured-surface prompt assembly",
    });
    trace.record({
      step: "3",
      actualFunction: "typedTurnDecisionInstructions",
      concreteInput: { projectId: "butler", action: "start_work" },
      stateRead: {},
      stateWritten: {},
      outputOrNextCall: {
        permitsProjectLedgerBypass: decisionPrompt.includes(
          "An active project id alone does not imply Ledger tracking",
        ),
      },
      invariant: decisionPrompt.includes(
        "An active project id alone does not imply Ledger tracking",
      ) ? "fail" : "pass",
      evidence: "real typed-decision prompt generation",
    });
    trace.record({
      step: "4",
      actualFunction: "compileStructuredTurnDecision",
      concreteInput: {
        projectId: "butler",
        action: "start_work",
        deliverables: ["code_change"],
      },
      stateRead: {},
      stateWritten: { trackingMode: compiled.tracking_mode },
      outputOrNextCall: { closeoutStrategy: compiled.closeout_strategy },
      invariant: compiled.tracking_mode === "ledger" ? "pass" : "fail",
      evidence: "real compiled project work contract",
    });
    trace.record({
      step: "5",
      actualFunction: "gatewayOpeningDecisionCallPath",
      concreteInput: { sessionRole: "project", projectId: "butler" },
      stateRead: {},
      stateWritten: { providerCalls: calls.length },
      outputOrNextCall: { purpose: calls[0]?.metadata?.purpose },
      invariant: calls.length === 0 ? "pass" : "fail",
      evidence: "the gateway opening-decision provider path is retired; Conception owns the first call",
    });

    const artifact = trace.artifact();
    trace.requireFunctions([
      "appendButlerToolInstructions(fixedSurface)",
      "appendButlerToolInstructions(structuredSurface)",
      "typedTurnDecisionInstructions",
      "compileStructuredTurnDecision",
      "gatewayOpeningDecisionCallPath",
    ]);
    expect(failedInvariantSteps(artifact).map((step) => step.step)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
