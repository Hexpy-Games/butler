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
  publicWorkDecisionsFromEnvelope,
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
import { isInternalProgressTool } from "../progress/runtime-semantic-progress.ts";
import {
  runPrivateTurnDecisionPrompt,
  type PrivateTurnDecisionValidation,
} from "./private-turn-decision-prompt.ts";
import {
  embeddedWorkBlockCalls,
  isWorkBlockTool,
  isWorkBlockToolExecutionResult,
  validateEmbeddedWorkBlockCall,
  validateWorkBlockDecision,
  workBlockEnvelope,
  workBlockTool,
  type WorkBlockToolExecutionResult,
} from "./work-block-tool.ts";
import {
  createObligationToolSurfaceSession,
  type ObligationToolSurfaceSeed,
} from "./obligation-tool-surface.ts";
import { modelFacingToolOutput } from "./model-facing-tool-output.ts";
import { bindRuntimeOwnedWorkspaceArguments } from "./model-facing-tool-arguments.ts";

const REASONING_EFFORT_VALUES = new Set<ReasoningEffort>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
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
  initialSemanticBlockSequence?: number;
  initialObligationFrontier?: ObligationToolSurfaceSeed;
  reviewFinalCandidate?: FunctionToolPromptOptions["reviewFinalCandidate"];
}) {
  let providerRoundIndex = Math.max(0, Math.floor(input.initialProviderRoundIndex ?? 0));
  let nextSemanticBlockSequence = Math.max(
    0,
    Math.floor(input.initialSemanticBlockSequence ?? 0),
  );
  const obligationToolSurfaceSession = createObligationToolSurfaceSession();
  const reviewFinalCandidate = input.reviewFinalCandidate
    ? async (candidate: Parameters<NonNullable<FunctionToolPromptOptions["reviewFinalCandidate"]>>[0]) => {
      const review = await input.reviewFinalCandidate!(candidate);
      if (review.status === "continue") {
        obligationToolSurfaceSession.focusMissingDeliverables(review.requiredDeliverables ?? []);
      }
      return review;
    }
    : undefined;
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
    obligationToolSurfaceState: () => obligationToolSurfaceSession.state(),
    nextSemanticBlockSequence: () => nextSemanticBlockSequence,
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
        const obligationToolSurface = obligationToolSurfaceSession.controllerFor(
          input.turnContractContext?.current?.contract,
          input.initialObligationFrontier,
        );
        let pendingDecisionFeedback: WorkBlockToolExecutionResult["decision_feedback"];
        try {
          const ordinaryTools = (
            tools: readonly FunctionToolPromptOptions["tools"][number][],
          ) => obligationToolSurface.project(
            tools.filter((tool) => !isWorkBlockTool(tool.name)),
          );
          const currentOrdinaryTools = () => ordinaryTools(
            toolSurface.dynamicTools?.() ?? toolSurface.tools,
          );
          const modelTools = (
            tools: readonly FunctionToolPromptOptions["tools"][number][],
          ) => {
            if (!input.turnContractContext?.current) return [...tools];
            const projected = ordinaryTools(tools);
            if (projected.length === 0) throw new Error("turn_contract_tool_surface_empty");
            return [workBlockTool(projected)];
          };
          const executeTool: FunctionToolPromptOptions["executeTool"] = async (call) => {
            if (isWorkBlockTool(call.name)) {
              const decisionFeedback = pendingDecisionFeedback;
              pendingDecisionFeedback = undefined;
              if (decisionFeedback) {
                return {
                  butler_work_block_result: true,
                  decision_feedback: decisionFeedback,
                  frontier: obligationToolSurface.state(),
                  results: [],
                } satisfies WorkBlockToolExecutionResult;
              }
              const availableTools = currentOrdinaryTools();
              const embeddedCalls = embeddedWorkBlockCalls(call.args, availableTools)
                .map((embedded) => bindRuntimeOwnedWorkspaceArguments(
                  embedded,
                  input.session.init.workspacePath,
                ));
              if (embeddedCalls.length === 0) throw new Error("work_block_calls_invalid");
              const results: WorkBlockToolExecutionResult["results"] = [];
              for (const embedded of embeddedCalls) {
                const validation = validateEmbeddedWorkBlockCall(embedded, availableTools);
                if (!validation.ok) {
                  results.push({
                    ...embedded,
                    ok: false,
                    error: `invalid_tool_arguments at ${validation.path}: ${validation.message}`,
                  });
                  continue;
                }
                input.phaseBudgetController?.recordToolCall({
                  phase,
                  toolName: embedded.name,
                });
                try {
                  const output = await input.executor({
                    name: embedded.name,
                    args: embedded.args,
                    rawArguments: JSON.stringify(embedded.args),
                  });
                  obligationToolSurface.observe({
                    name: embedded.name,
                    args: embedded.args,
                    result: output,
                  });
                  results.push({
                    ...embedded,
                    ok: toolResultSucceeded(output),
                    output: modelFacingToolOutput(output, input.session.init.workspacePath),
                  });
                } catch (error) {
                  results.push({
                    ...embedded,
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              }
              return {
                butler_work_block_result: true,
                frontier: obligationToolSurface.state(),
                results,
              } satisfies WorkBlockToolExecutionResult;
            }
            input.phaseBudgetController?.recordToolCall({
              phase,
              toolName: call.name,
            });
            const result = await input.executor(call);
            obligationToolSurface.observe({
              name: call.name,
              args: call.args,
              result,
            });
            return result;
          };
          const text = await input.deps.toolPromptRunner({
            prompt: promptText,
            model: input.turnInput.model,
            reasoningEffort,
            instructions: appendRoleToolPolicyInstructions(
              input.session.init.role,
              appendButlerToolInstructions(input.session.init.systemPrompt, {
                availableToolNames: ordinaryTools(toolSurface.tools).map((tool) => tool.name),
                fixedSurface: fixedToolSurface ||
                  input.turnContractContext?.current?.contract.action === "inspect",
                structuredSurface: Boolean(input.turnContractContext?.current),
              }),
            ),
            cacheScope: "session-turn",
            signal: input.turnInput.signal,
            attachments: input.attachments,
            tools: modelTools(toolSurface.tools),
            dynamicTools: () => modelTools(toolSurface.dynamicTools?.() ?? toolSurface.tools),
            maxToolRounds: grantedToolRounds,
            handoffAfterToolBatch: false,
            butlerData: input.deps.butlerData,
            usageAttribution: usageAttribution(phase),
            onProviderStreamEvent: projector.project,
            executeTool,
            reviewFinalCandidate,
            finalTextFromToolResult: ({ name, output }) => {
              const results = isWorkBlockTool(name) && isWorkBlockToolExecutionResult(output)
                ? output.results
                : [{ name, ok: true, output }];
              for (const result of results) {
                if (!result.ok) continue;
                if (result.name === "write_planned_public_report") {
                  return publicReportFromToolOutput(result.output);
                }
                if (input.plannedReview) {
                  const terminal = plannedReviewTerminalToolText({
                    name: result.name,
                    output: result.output,
                    language: input.deps.messageLanguage,
                  });
                  if (terminal) return terminal;
                }
              }
              return null;
            },
            onAssistantTextBeforeTools: async ({ text, toolCalls }) => {
              throwIfRuntimeTurnAborted(input.turnInput.signal);
              const wrapperCall = toolCalls.find((toolCall) => isWorkBlockTool(toolCall.name));
              const visibleToolCalls = wrapperCall
                ? embeddedWorkBlockCalls(wrapperCall.args, currentOrdinaryTools())
                : toolCalls;
              const declaredDecisionEnvelope = wrapperCall
                ? workBlockEnvelope(wrapperCall.args)
                : null;
              if (wrapperCall && !declaredDecisionEnvelope) {
                const validation = validateWorkBlockDecision(wrapperCall.args);
                pendingDecisionFeedback = {
                  status: "repaired",
                  correction: validation.ok
                    ? "Keep block_title distinct from objective in the next work block."
                    : validation.correction,
                };
                return;
              }
              pendingDecisionFeedback = undefined;
              if (visibleToolCalls.length > 0) {
                input.phaseBudgetController?.beforeToolCallBatch({
                  phase,
                  toolNames: visibleToolCalls.map((toolCall) => toolCall.name),
                });
              }
              input.markAssistantTextBeforeToolsSeen();
              const semanticToolCalls = visibleToolCalls.filter((toolCall) =>
                !isInternalProgressTool(toolCall.name),
              );
              if (semanticToolCalls.length === 0) {
                if (visibleToolCalls.length === 0 && !text.trim()) return;
                await emitAssistantTextBeforeTools({
                  turnInput: input.turnInput,
                  text,
                  toolCalls: visibleToolCalls,
                  language: input.deps.messageLanguage,
                });
                return;
              }
              const active = input.turnContractContext?.current;
              const currentProviderRound = providerRoundIndex;
              const currentSemanticBlockSequence = nextSemanticBlockSequence;
              const contractContext = active
                ? {
                  contractId: active.contract.contract_id,
                  ...(active.contract.target_workstream_id
                    ? { workstreamId: active.contract.target_workstream_id }
                    : {}),
                  semanticBlockId: `${active.contract.contract_id}:block:${currentSemanticBlockSequence}`,
                  usageGroupId: `${active.contract.contract_id}:round:${currentProviderRound}`,
                }
                : undefined;
              const openingDecisionAvailable = Boolean(
                active &&
                currentProviderRound === 0 &&
                input.pendingPublicDecisions.some((decision) =>
                  decision.contractId === active.contract.contract_id &&
                  decision.providerRound === 0,
                ),
              );
              let nextPendingDecisions = openingDecisionAvailable
                ? []
                : declaredDecisionEnvelope
                ? publicWorkDecisionsFromEnvelope({
                  envelope: declaredDecisionEnvelope,
                  toolCalls: semanticToolCalls,
                  existingDecisions: input.publicDecisionContext,
                  ...(contractContext ? { contractContext } : {}),
                })
                : publicWorkDecisionsFromAssistantText({
                  text,
                  toolCalls: semanticToolCalls,
                  language: input.deps.messageLanguage,
                  existingDecisions: input.publicDecisionContext,
                  ...(contractContext ? { contractContext } : {}),
                });
              if (!openingDecisionAvailable && nextPendingDecisions.length === 0) {
                const envelope = declaredDecisionEnvelope;
                if (envelope) {
                  nextPendingDecisions = publicWorkDecisionsFromEnvelope({
                    envelope,
                    toolCalls: semanticToolCalls,
                    existingDecisions: input.publicDecisionContext,
                    ...(contractContext ? { contractContext } : {}),
                  });
                }
              }
              if (!openingDecisionAvailable) {
                input.pendingPublicDecisions.length = 0;
              }
              const nextProviderRound = currentProviderRound + 1;
              if (nextPendingDecisions.length > 0) {
                for (const d of nextPendingDecisions) {
                  d.providerRound = currentProviderRound;
                }
                input.pendingPublicDecisions.push(...nextPendingDecisions);
                nextSemanticBlockSequence = currentSemanticBlockSequence + 1;
              } else if (openingDecisionAvailable && active) {
                const hasContractDecision = hasCompleteAuthoredPublicDecisionForTool({
                  pending: input.pendingPublicDecisions.filter((decision) =>
                    decision.contractId === active.contract.contract_id,
                  ),
                  toolName: semanticToolCalls[0]!.name,
                });
                const boundedBatchSize = Math.min(semanticToolCalls.length, 6);
                if (hasContractDecision) {
                  for (const decision of input.pendingPublicDecisions) {
                    if (decision.contractId !== active.contract.contract_id) continue;
                    decision.toolBatchSize = boundedBatchSize;
                  }
                }
                nextSemanticBlockSequence = Math.max(
                  nextSemanticBlockSequence,
                  ...input.pendingPublicDecisions
                    .filter((decision) => decision.contractId === active.contract.contract_id)
                    .map((decision) => semanticBlockSequence(decision.semanticBlockId) + 1),
                );
              }
              providerRoundIndex = nextProviderRound;
              await emitAssistantTextBeforeTools({
                turnInput: input.turnInput,
                text,
                toolCalls: visibleToolCalls,
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

function toolResultSucceeded(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  return (value as Record<string, unknown>).ok !== false;
}

function semanticBlockSequence(value: unknown): number {
  if (typeof value !== "string") return -1;
  const marker = ":block:";
  const markerIndex = value.lastIndexOf(marker);
  if (markerIndex < 0) return -1;
  const sequence = Number(value.slice(markerIndex + marker.length));
  return Number.isInteger(sequence) && sequence >= 0 ? sequence : -1;
}
