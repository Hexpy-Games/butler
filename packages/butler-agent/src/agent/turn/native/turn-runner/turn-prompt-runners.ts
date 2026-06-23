import type { FunctionToolPromptOptions, PromptUsageAttribution } from "../../../../integrations/providers/provider.ts";
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
import { publicWorkDecisionsFromAssistantText } from "../../../output/public-work-decisions.ts";
import { throwIfRuntimeTurnAborted } from "../policy/turn-errors.ts";
import { emitAssistantTextBeforeTools } from "./assistant-pretool-progress.ts";
import type { ToolSurfacePromptController } from "../../tool-surface-prompt-controller.ts";
import type { PlannedReviewTurnContext } from "../context/planned-review-context.ts";
import type { NativeTurnRunnerDeps, NativeStoredSessionConfig } from "./turn-runner-types.ts";
import type { PublicWorkDecision } from "../output/tool-types.ts";
import type { inboundAttachments } from "../context/turn-prompt.ts";
import type {
  createDirectTurnBudget,
  promptUsageSectionsFromPrompt,
} from "../../direct-turn-budget.ts";

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
}) {
  const usageAttribution = (phase: string, roundIndex?: number): PromptUsageAttribution => ({
    turnId: input.turnId,
    phase,
    ...(roundIndex === undefined ? {} : { roundIndex }),
    budgetState: directTurnBudgetState(input.turnBudget),
    getBudgetState: () => directTurnBudgetState(input.turnBudget),
    beforeModelRequest: () => beforeDirectTurnModelRequest(input.turnBudget),
    afterModelResponseUsage: (usage) => addDirectTurnUsage({
      budget: input.turnBudget,
      promptTokens: usage.promptTokens,
      cachedTokens: usage.cachedTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    }),
    promptSections: input.promptSections,
  });

  return {
    runToolPrompt: async (
      promptText: string,
      maxToolRounds = DIRECT_TOOL_CHAIN_MAX_ROUNDS,
      phase = "tool_loop",
    ): Promise<string> => {
      throwIfRuntimeTurnAborted(input.turnInput.signal);
      const grantedToolRounds = directToolRoundLimit(maxToolRounds);
      return await input.toolSurfaceController.runWithSelectedSurface(async (toolSurface) => {
        return await input.deps.toolPromptRunner({
          prompt: promptText,
          model: input.turnInput.model,
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
          executeTool: input.executor,
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
      });
    },
    runTextPrompt: async (promptText: string): Promise<string> => {
      return await input.deps.promptRunner({
        prompt: promptText,
        model: input.turnInput.model,
        instructions: input.session.init.systemPrompt,
        cacheScope: "session-turn",
        signal: input.turnInput.signal,
        attachments: input.attachments,
        butlerData: input.deps.butlerData,
        usageAttribution: usageAttribution("text_prompt", 0),
      });
    },
  };
}
