import type {
  FunctionToolPromptOptions,
  PromptUsageAttribution,
  PromptUsageSectionAttribution,
  ReasoningEffort,
} from "../../../../integrations/providers/provider.ts";
import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import {
  addDirectTurnUsage,
  beforeDirectTurnModelRequest,
  directTurnBudgetState,
} from "../../direct-turn-budget.ts";
import {
  DIRECT_TOOL_CHAIN_MAX_ROUNDS,
  directToolRoundLimit,
} from "../../tool-loop-guards.ts";
import {
  appendButlerToolInstructions,
  appendRoleToolPolicyInstructions,
} from "../output/tool-instructions.ts";
import {
  plannedReviewTerminalToolText,
  publicReportFromToolOutput,
} from "../output/tool-result-text.ts";
import {
  hasCompleteAuthoredPublicDecisionForTool,
  publicWorkDecisionsFromAssistantText,
} from "../../../output/public-work/decisions.ts";
import { throwIfRuntimeTurnAborted } from "../policy/turn-errors.ts";
import { metadataPolicyValue } from "../policy/turn-metadata-policy.ts";
import { emitAssistantTextBeforeTools } from "./assistant-pretool-progress.ts";
import { createProviderStreamTurnEventProjector } from "../stream/provider-stream-projector.ts";
import { emitTurnEventBestEffort } from "../progress/turn-delivery-events.ts";
import type { TurnLatencyMetricRecorder } from "../../../../operations/metrics/turn-latency.ts";
import type {
  SelectedToolSurfacePromptState,
  ToolSurfacePromptController,
} from "../../tool-surface-prompt-controller.ts";
import type { PlannedReviewTurnContext } from "../context/planned-review-context.ts";
import type { NativeTurnRunnerDeps, NativeStoredSessionConfig } from "./turn-runner-types.ts";
import type { PublicWorkDecision } from "../output/tool-types.ts";
import type { inboundAttachments } from "../context/turn-prompt.ts";
import type {
  createDirectTurnBudget,
  promptUsageSectionsFromPrompt,
} from "../../direct-turn-budget.ts";
import type { WorkStreamPhaseBudgetController } from "../../workstream-phase-budget.ts";
import type { ActiveTurnContract } from "./turn-contract-runtime.ts";
import {
  runPrivateTurnDecisionPrompt,
  type PrivateTurnDecisionValidation,
} from "./private-turn-decision-prompt.ts";

const REASONING_EFFORT_VALUES = new Set<ReasoningEffort>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
]);
function selectedReasoningEffort(turnInput: RuntimeTurnInput): ReasoningEffort | undefined {
  const snakeCase = metadataPolicyValue(turnInput.metadata, "reasoning_effort");
  const camelCase = metadataPolicyValue(turnInput.metadata, "reasoningEffort");
  if (isReasoningEffort(snakeCase)) return snakeCase;
  if (isReasoningEffort(camelCase)) return camelCase;
  return undefined;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORT_VALUES.has(value as ReasoningEffort);
}

export function createNativeTurnPromptRunners(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  deps: NativeTurnRunnerDeps;
  turnId: string;
  turnBudget: ReturnType<typeof createDirectTurnBudget>;
  promptSections: ReturnType<typeof promptUsageSectionsFromPrompt>;
  attachments: ReturnType<typeof inboundAttachments>;
  executor: FunctionToolPromptOptions["executeTool"];
  toolSurfaceController: ToolSurfacePromptController;
  plannedReview: PlannedReviewTurnContext | null;
  publicDecisionContext: PublicWorkDecision[];
  pendingPublicDecisions: PublicWorkDecision[];
  markAssistantTextBeforeToolsSeen: () => void;
  latencyTracker?: TurnLatencyMetricRecorder;
  phaseBudgetController?: WorkStreamPhaseBudgetController | null;
  turnContractContext?: { current: ActiveTurnContract | null };
  initialProviderRoundIndex?: number;
}) {
  let providerRoundIndex = Math.max(0, Math.floor(input.initialProviderRoundIndex ?? 0));
  const usageAttribution = (
    phase: string,
    roundIndex?: number,
    promptSections: PromptUsageSectionAttribution[] = input.promptSections,
  ): PromptUsageAttribution => ({
    turnId: input.turnId,
    phase,
    ...(roundIndex === undefined ? {} : { roundIndex }),
    budgetState: directTurnBudgetState(input.turnBudget),
    getBudgetState: () => directTurnBudgetState(input.turnBudget),
    beforeModelRequest: (request) => {
      input.phaseBudgetController?.beforeModelRequest({
        phase,
        roundIndex: request.roundIndex,
        globalBudgetState: directTurnBudgetState(input.turnBudget),
      });
      beforeDirectTurnModelRequest(input.turnBudget);
      const budgetState = directTurnBudgetState(input.turnBudget);
      input.latencyTracker?.recordModelRequest({
        phase,
        roundIndex: request.roundIndex,
        budgetState,
      });
    },
    afterModelResponseUsage: (usage) => {
      addDirectTurnUsage({
        budget: input.turnBudget,
        promptTokens: usage.promptTokens,
        cachedTokens: usage.cachedTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      });
      input.latencyTracker?.recordModelResponseUsage({
        phase,
        roundIndex: usage.roundIndex,
        promptTokens: usage.promptTokens,
        cachedTokens: usage.cachedTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        budgetState: directTurnBudgetState(input.turnBudget),
      });
    },
    promptSections,
  });
  const streamProjector = (phase: string) => createProviderStreamTurnEventProjector({
    turnId: input.turnId,
    defaultStreamId: `${input.turnId}:${phase}`,
    emitTurnEvent: async (event) => {
      await emitTurnEventBestEffort(input.turnInput, event);
    },
    onPublicTextDelta: ({ target }) => {
      input.latencyTracker?.recordFirstModelDelta({
        phase,
        target,
      });
    },
  });
  const reasoningEffort = selectedReasoningEffort(input.turnInput);
  const fixedToolSurface = (
    metadataPolicyValue(input.turnInput.metadata, "toolSurfaceMode") ??
    metadataPolicyValue(input.turnInput.metadata, "tool_surface_mode")
  ) === "fixed";

  return {
    runToolPrompt: async (
      promptText: string,
      maxToolRounds = DIRECT_TOOL_CHAIN_MAX_ROUNDS,
      phase = "tool_loop",
    ): Promise<string> => {
      throwIfRuntimeTurnAborted(input.turnInput.signal);
      const phaseMaxToolRounds = input.phaseBudgetController?.maxToolRoundsForPhase(
        phase,
        maxToolRounds,
      ) ?? maxToolRounds;
      const grantedToolRounds = directToolRoundLimit(phaseMaxToolRounds);
      async function runPromptWithSelectedSurface(toolSurface: SelectedToolSurfacePromptState): Promise<string> {
        const projector = streamProjector(phase);
        try {
          const executeTool: FunctionToolPromptOptions["executeTool"] = async (call) => {
            input.phaseBudgetController?.recordToolCall({
              phase,
              toolName: call.name,
            });
            return await input.executor(call);
          };
          const text = await input.deps.toolPromptRunner({
            prompt: promptText,
            model: input.turnInput.model,
            reasoningEffort,
            instructions: appendRoleToolPolicyInstructions(
              input.session.init.role,
              appendButlerToolInstructions(input.session.init.systemPrompt, {
                availableToolNames: toolSurface.tools.map((tool) => tool.name),
                fixedSurface: fixedToolSurface ||
                  input.turnContractContext?.current?.contract.action === "inspect",
              }),
            ),
            cacheScope: "session-turn",
            signal: input.turnInput.signal,
            attachments: input.attachments,
            tools: toolSurface.tools,
            dynamicTools: toolSurface.dynamicTools,
            maxToolRounds: grantedToolRounds,
            handoffAfterToolBatch: false,
            butlerData: input.deps.butlerData,
            usageAttribution: usageAttribution(phase),
            onProviderStreamEvent: projector.project,
            executeTool,
            finalTextFromToolResult: ({ name, output }) => {
              if (name === "write_planned_public_report") {
                return publicReportFromToolOutput(output);
              }
              if (input.plannedReview) {
                return plannedReviewTerminalToolText({
                  name,
                  output,
                  language: input.deps.messageLanguage,
                });
              }
              return null;
            },
            onAssistantTextBeforeTools: async ({ text, toolCalls }) => {
              throwIfRuntimeTurnAborted(input.turnInput.signal);
              input.phaseBudgetController?.beforeToolCallBatch({
                phase,
                toolNames: toolCalls.map((toolCall) => toolCall.name),
              });
              input.markAssistantTextBeforeToolsSeen();
              const active = input.turnContractContext?.current;
              const openingDecisionAvailable = Boolean(
                active &&
                providerRoundIndex === 0 &&
                input.pendingPublicDecisions.some((decision) =>
                  decision.contractId === active.contract.contract_id &&
                  decision.providerRound === 0 &&
                  (decision.usageCount ?? 0) === 0,
                ),
              );
              const nextPendingDecisions = openingDecisionAvailable
                ? []
                : publicWorkDecisionsFromAssistantText({
                  text,
                  toolCalls,
                  language: input.deps.messageLanguage,
                  existingDecisions: input.publicDecisionContext,
                  ...(active
                    ? {
                      contractContext: {
                        contractId: active.contract.contract_id,
                        ...(active.contract.target_workstream_id
                          ? { workstreamId: active.contract.target_workstream_id }
                          : {}),
                        semanticBlockId: `${active.contract.contract_id}:block:${providerRoundIndex + 1}`,
                        usageGroupId: `${active.contract.contract_id}:round:${providerRoundIndex + 1}`,
                      },
                    }
                    : {}),
                });
              if (nextPendingDecisions.length > 0) {
                input.pendingPublicDecisions.length = 0;
                providerRoundIndex += 1;
                for (const d of nextPendingDecisions) {
                  d.providerRound = providerRoundIndex;
                }
                input.pendingPublicDecisions.push(...nextPendingDecisions);
              } else if (active && toolCalls.length > 0) {
                const hasContractDecision = hasCompleteAuthoredPublicDecisionForTool({
                  pending: input.pendingPublicDecisions.filter((decision) =>
                    decision.contractId === active.contract.contract_id,
                  ),
                  toolName: toolCalls[0]!.name,
                });
                const boundedBatchSize = Math.min(toolCalls.length, 6);
                if (hasContractDecision) {
                  for (const decision of input.pendingPublicDecisions) {
                    if (decision.contractId !== active.contract.contract_id) continue;
                    decision.toolBatchSize = boundedBatchSize;
                  }
                }
              }
              await emitAssistantTextBeforeTools({
                turnInput: input.turnInput,
                text,
                toolCalls,
                language: input.deps.messageLanguage,
              });
            },
          });
          if (text.trim()) {
            input.latencyTracker?.recordFirstModelDelta({
              phase,
              target: "final_candidate",
            });
          }
          await projector.completeOpenStreams("completed");
          return text;
        } catch (error) {
          await projector.completeOpenStreams(input.turnInput.signal?.aborted ? "aborted" : "failed");
          throw error;
        }
      }
      return await input.toolSurfaceController.runWithSelectedSurface(runPromptWithSelectedSurface);
    },
    runTextPrompt: async (promptText: string, phase = "text_prompt"): Promise<string> => {
      const projector = streamProjector(phase);
      try {
        const text = await input.deps.promptRunner({
          prompt: promptText,
          model: input.turnInput.model,
          reasoningEffort,
          instructions: input.session.init.systemPrompt,
          cacheScope: "session-turn",
          signal: input.turnInput.signal,
          attachments: input.attachments,
          butlerData: input.deps.butlerData,
          usageAttribution: usageAttribution(phase, 0),
          onProviderStreamEvent: projector.project,
        });
        if (text.trim()) {
          input.latencyTracker?.recordFirstModelDelta({
            phase,
            target: "final_candidate",
          });
        }
        await projector.completeOpenStreams("completed");
        return text;
      } catch (error) {
        await projector.completeOpenStreams(input.turnInput.signal?.aborted ? "aborted" : "failed");
        throw error;
      }
    },
    runPrivateTextPrompt: async (
      promptText: string,
      phase = "private_text_prompt",
      promptSections?: PromptUsageSectionAttribution[],
      responseFormat?: Parameters<NativeTurnRunnerDeps["promptRunner"]>[0]["responseFormat"],
    ): Promise<string> => {
      const text = await input.deps.promptRunner({
        prompt: promptText,
        model: input.turnInput.model,
        reasoningEffort,
        instructions: input.session.init.systemPrompt,
        cacheScope: "session-turn",
        signal: input.turnInput.signal,
        attachments: input.attachments,
        responseFormat,
        butlerData: input.deps.butlerData,
        usageAttribution: usageAttribution(phase, 0, promptSections),
      });
      if (text.trim()) {
        input.latencyTracker?.recordFirstModelDelta({
          phase,
          target: "final_candidate",
        });
      }
      return text;
    },
    runPrivateFunctionDecisionPrompt: async (
      promptText: string,
      phase = "private_function_decision",
      promptSections?: PromptUsageSectionAttribution[],
      responseFormat?: Parameters<NativeTurnRunnerDeps["promptRunner"]>[0]["responseFormat"],
      validateDecision?: (args: Record<string, unknown>) => PrivateTurnDecisionValidation,
    ): Promise<string> => await runPrivateTurnDecisionPrompt({
        promptText,
        phase,
        promptSections,
        responseFormat,
        model: input.turnInput.model,
        reasoningEffort,
        systemPrompt: input.session.init.systemPrompt,
        signal: input.turnInput.signal,
        attachments: input.attachments,
        butlerData: input.deps.butlerData,
        toolPromptRunner: input.deps.toolPromptRunner,
        usageAttribution,
        latencyTracker: input.latencyTracker,
        validateDecision,
      }),
  };
}
