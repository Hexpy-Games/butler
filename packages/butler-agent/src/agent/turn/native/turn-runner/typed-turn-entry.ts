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
  openingDecisionPayload,
  type ActiveTurnContract,
} from "./turn-contract-runtime.ts";
import {
  compileStructuredTurnDecision,
  parseStructuredTurnDecision,
  stableTurnDecisionId,
  structuredDecisionRepairPrompt,
  TURN_DECISION_REPAIR_LIMIT,
  turnContractCandidates,
  turnDecisionResponseFormat,
  typedTurnDecisionInstructions,
} from "./typed-turn-decision.ts";
import type { PublicWorkDecision } from "../output/tool-types.ts";
import type { NativeStoredSessionConfig } from "./turn-runner-types.ts";

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
  runKernelToolPrompt: (
    prompt: string,
    maxToolRounds?: number,
    phase?: string,
  ) => Promise<string>;
}): Promise<{ candidateText: string; activeTurnContract: ActiveTurnContract }> {
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
  let currentPrompt = decisionPrompt.prompt;
  let active: ActiveTurnContract | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= TURN_DECISION_REPAIR_LIMIT; attempt += 1) {
    try {
      const raw = await input.runPrivateTextPrompt(
        currentPrompt,
        attempt === 0 ? "typed_turn_decision" : "typed_turn_decision_repair",
        decisionPrompt.promptSections,
        responseFormat,
      );
      const decision = parseStructuredTurnDecision(raw, decisionId);
      const contract = compileStructuredTurnDecision({
        decision,
        candidates,
        workspaceId: input.projectId ?? input.turnInput.handle.sessionId,
        projectId: input.projectId,
      });
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
    } catch (error) {
      lastError = error;
      if (attempt >= TURN_DECISION_REPAIR_LIMIT) throw error;
      currentPrompt = structuredDecisionRepairPrompt({ prompt: decisionPrompt.prompt, error });
    }
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
    contractExecutionPrompt({ basePrompt: input.context.prompt, active }),
    undefined,
    input.initialPromptPhase,
  );
  return { candidateText, activeTurnContract: active };
}

function uniqueResumeCandidates<T extends { id: string }>(candidates: T[]): T[] {
  return [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
}
