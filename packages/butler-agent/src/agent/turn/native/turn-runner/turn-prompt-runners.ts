import type {
  FunctionToolPromptOptions,
  PromptUsageAttribution,
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
import { publicWorkDecisionsFromAssistantText } from "../../../output/public-work/decisions.ts";
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
}) {
  const usageAttribution = (phase: string, roundIndex?: number): PromptUsageAttribution => ({
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
    promptSections: input.promptSections,
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
              appendButlerToolInstructions(input.session.init.systemPrompt),
            ),
            cacheScope: "session-turn",
            signal: input.turnInput.signal,
            attachments: input.attachments,
            tools: toolSurface.tools,
            dynamicTools: toolSurface.dynamicTools,
            maxToolRounds: grantedToolRounds,
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
              input.markAssistantTextBeforeToolsSeen();
              input.pendingPublicDecisions.push(...publicWorkDecisionsFromAssistantText({
                text,
                toolCalls,
                language: input.deps.messageLanguage,
                existingDecisions: input.publicDecisionContext,
              }));
              await emitAssistantTextBeforeTools({
                turnInput: input.turnInput,
                text,
                toolCalls,
                language: input.deps.messageLanguage,
              });
            },
          });
          await projector.completeOpenStreams("completed");
          return text;
        } catch (error) {
          await projector.completeOpenStreams(input.turnInput.signal?.aborted ? "aborted" : "failed");
          throw error;
        }
      }
      return await input.toolSurfaceController.runWithSelectedSurface(runPromptWithSelectedSurface);
    },
    runTextPrompt: async (promptText: string): Promise<string> => {
      const projector = streamProjector("text_prompt");
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
          usageAttribution: usageAttribution("text_prompt", 0),
          onProviderStreamEvent: projector.project,
        });
        await projector.completeOpenStreams("completed");
        return text;
      } catch (error) {
        await projector.completeOpenStreams(input.turnInput.signal?.aborted ? "aborted" : "failed");
        throw error;
      }
    },
  };
}
