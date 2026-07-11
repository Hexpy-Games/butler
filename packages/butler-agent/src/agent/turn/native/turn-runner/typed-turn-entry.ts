import type { PromptUsageSectionAttribution } from "../../../../integrations/providers/provider.ts";
import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import type { PlannedReviewTurnContext } from "../context/planned-review-context.ts";
import type { ToolSurfacePromptController } from "../../tool-surface-prompt-controller.ts";
import type { WorkStreamResumeCandidate } from "../../workstream-checkpoint-resume-types.ts";
import { emitTurnEventBestEffort } from "../progress/turn-delivery-events.ts";
import { buildThinFirstResponsePrompt, shouldUseThinFirstResponse } from "./thin-first-response.ts";
import {
  activateTurnContract,
  contractExecutionPrompt,
  contractResumePrompt,
  openingDecisionPayload,
  restoreTurnContractExecution,
  type ActiveTurnContract,
} from "./turn-contract-runtime.ts";
import {
  compileStructuredTurnDecision,
  canonicalFunctionDecisionArgs,
  parseStructuredTurnDecision,
  stableTurnDecisionId,
  structuredDecisionRepairPrompt,
  structuredDecisionRepairGuidance,
  TURN_DECISION_REPAIR_LIMIT,
  turnContractCandidates,
  turnDecisionResponseFormat,
  typedTurnDecisionInstructions,
} from "./typed-turn-decision.ts";
import type { PublicWorkDecision } from "../output/tool-types.ts";
import type { NativeStoredSessionConfig } from "./turn-runner-types.ts";
import type { TurnContextAtom } from "../../turn-continuation-context.ts";

interface TypedTurnEntryContext {
  turnId: string;
  chatId?: string | null;
  prompt: string;
  userText: string;
  promptSections: PromptUsageSectionAttribution[];
  plannedReview: PlannedReviewTurnContext | null;
  resumeSelection: {
    candidates: WorkStreamResumeCandidate[];
    blockers: WorkStreamResumeCandidate[];
  };
  resumeDecisionEnvelope?: { prompt: string } | null;
  focusedResumeEnvelope?: { prompt: string } | null;
  toolSurfaceController: ToolSurfacePromptController;
  continuationAtom?: TurnContextAtom | null;
}

type StructuredResponseFormat = ReturnType<typeof turnDecisionResponseFormat>;

export async function runTypedTurnEntry(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  butlerData: string;
  projectId?: string;
  context: TypedTurnEntryContext;
  initialPromptPhase: string;
  pendingPublicDecisions: PublicWorkDecision[];
  turnContractContext: { current: ActiveTurnContract | null };
  runPrivateTextPrompt: (
    prompt: string,
    phase: string,
    sections: PromptUsageSectionAttribution[],
    responseFormat: StructuredResponseFormat,
  ) => Promise<string>;
  runPrivateFunctionDecisionPrompt: (
    prompt: string,
    phase: string,
    sections: PromptUsageSectionAttribution[],
    responseFormat: StructuredResponseFormat,
    validateDecision: (args: Record<string, unknown>) =>
      | { ok: true; canonicalArgs: Record<string, unknown> }
      | {
        ok: false;
        errorCode: string;
        correction: string;
        canonicalArgs: Record<string, unknown>;
      },
  ) => Promise<string>;
  runKernelToolPrompt: (
    prompt: string,
    maxToolRounds?: number,
    phase?: string,
  ) => Promise<string>;
}): Promise<{ candidateText: string; activeTurnContract: ActiveTurnContract }> {
  const resumed = await resumeTypedTurnEntry(input);
  if (resumed) return resumed;
  const candidates = turnContractCandidates({
    butlerData: input.butlerData,
    candidates: uniqueResumeCandidates([
      ...input.context.resumeSelection.candidates,
      ...input.context.resumeSelection.blockers,
    ]),
  });
  const decisionId = stableTurnDecisionId(input.context.turnId);
  const candidateIds = candidates.workstreams?.map((candidate) => candidate.workstream_id) ?? [];
  const decisionInstructions = typedTurnDecisionInstructions({
    decisionId,
    projectId: input.projectId,
    candidateIds,
  });
  const thin = shouldUseThinFirstResponse({
    turnInput: input.turnInput,
    session: input.session,
    plannedReview: input.context.plannedReview,
  });
  const decisionPrompt = thin
    ? buildThinFirstResponsePrompt({
      fullPrompt: input.context.prompt,
      userText: input.context.userText,
      decisionInstructions,
      workstreamCapsule: input.context.resumeDecisionEnvelope?.prompt ??
        input.context.focusedResumeEnvelope?.prompt,
      personaFallback: input.session.init.systemPrompt,
    })
    : {
      prompt: [input.context.prompt, decisionInstructions].join("\n\n"),
      promptSections: input.context.promptSections,
    };
  const responseFormat = turnDecisionResponseFormat({
    decisionId,
    projectId: input.projectId,
    candidateIds,
    waitingBlockerIds: candidates.workstreams
      ?.map((candidate) => candidate.waiting_user_blocker_id)
      .filter((id): id is string => Boolean(id)) ?? [],
  });
  const decisionTransport = input.turnInput.provider.capabilities.structuredDecisionTransport;
  if (!decisionTransport) {
    throw new Error("turn_contract_structured_decision_transport_missing");
  }
  let currentPrompt = decisionPrompt.prompt;
  let active: ActiveTurnContract | null = null;
  let lastError: unknown = null;
  const repairLimit = TURN_DECISION_REPAIR_LIMIT;
  const validateFunctionDecision = (args: Record<string, unknown>) => {
    const canonicalArgs = canonicalFunctionDecisionArgs(args);
    try {
      const decision = parseStructuredTurnDecision(JSON.stringify(canonicalArgs), decisionId);
      compileStructuredTurnDecision({
        decision,
        candidates,
        workspaceId: input.projectId ?? input.turnInput.handle.sessionId,
        projectId: input.projectId,
      });
      return { ok: true, canonicalArgs } as const;
    } catch (error) {
      const errorCode = error instanceof Error ? error.message : "turn_contract_decision_invalid";
      return {
        ok: false,
        errorCode,
        correction: structuredDecisionRepairGuidance(errorCode),
        canonicalArgs,
      } as const;
    }
  };
  for (let attempt = 0; attempt <= repairLimit; attempt += 1) {
    const phase = attempt === 0 ? "typed_turn_decision" : "typed_turn_decision_repair";
    const raw = decisionTransport === "function_tool"
      ? await input.runPrivateFunctionDecisionPrompt(
        currentPrompt,
        phase,
        decisionPrompt.promptSections,
        responseFormat,
        validateFunctionDecision,
      )
      : await input.runPrivateTextPrompt(
        currentPrompt,
        phase,
        decisionPrompt.promptSections,
        responseFormat,
      );
    let decision: ReturnType<typeof parseStructuredTurnDecision>;
    let contract: ReturnType<typeof compileStructuredTurnDecision>;
    try {
      decision = parseStructuredTurnDecision(raw, decisionId);
      contract = compileStructuredTurnDecision({
        decision,
        candidates,
        workspaceId: input.projectId ?? input.turnInput.handle.sessionId,
        projectId: input.projectId,
      });
    } catch (error) {
      lastError = error;
      if (attempt >= repairLimit) throw error;
      currentPrompt = structuredDecisionRepairPrompt({
        prompt: decisionPrompt.prompt,
        error,
        transport: decisionTransport,
      });
      continue;
    }
    active = activateTurnContract({
      butlerData: input.butlerData,
      contract,
      decision,
      sessionId: input.turnInput.handle.sessionId,
      chatId: input.context.chatId,
      projectId: input.projectId,
      turnId: input.context.turnId,
      turnMetadata: input.turnInput.metadata,
      toolSurfaceController: input.context.toolSurfaceController,
    });
    break;
  }
  if (!active) throw lastError ?? new Error("turn_contract_decision_unavailable");
  input.turnContractContext.current = active;
  if (active.contract.action === "answer") {
    return { candidateText: active.decision.answer_text ?? "", activeTurnContract: active };
  }
  if (active.contract.action === "cancel_work") {
    return { candidateText: active.decision.public_summary, activeTurnContract: active };
  }
  await emitTurnEventBestEffort(input.turnInput, {
    kind: "assistant.decision",
    payload: openingDecisionPayload(active),
  });
  input.pendingPublicDecisions.push(active.publicDecision);
  const candidateText = await input.runKernelToolPrompt(
    contractExecutionPrompt({
      basePrompt: input.context.prompt,
      active,
      butlerData: input.butlerData,
    }),
    undefined,
    input.initialPromptPhase,
  );
  return { candidateText, activeTurnContract: active };
}

async function resumeTypedTurnEntry(
  input: Parameters<typeof runTypedTurnEntry>[0],
): Promise<{ candidateText: string; activeTurnContract: ActiveTurnContract } | null> {
  const atom = input.context.continuationAtom;
  if (!atom) return null;
  if (!atom.contractId || !atom.turnDecision) {
    throw new Error("turn_continuation_contract_state_missing");
  }
  const nextSemanticBlockSequence = atom.nextSemanticBlockSequence ?? 1;
  const active = restoreTurnContractExecution({
    butlerData: input.butlerData,
    contractId: atom.contractId,
    decision: atom.turnDecision,
    nextSemanticBlockSequence,
    turnMetadata: input.turnInput.metadata,
    toolSurfaceController: input.context.toolSurfaceController,
  });
  if (atom.workStreamId && active.contract.target_workstream_id !== atom.workStreamId) {
    throw new Error("turn_continuation_workstream_conflict");
  }
  input.turnContractContext.current = active;
  const candidateText = await input.runKernelToolPrompt(
    contractResumePrompt({
      basePrompt: input.context.prompt,
      active,
      nextSemanticBlockSequence,
    }),
    undefined,
    input.initialPromptPhase,
  );
  return { candidateText, activeTurnContract: active };
}

function uniqueResumeCandidates<T extends { id: string }>(candidates: T[]): T[] {
  return [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
}
