import type {
  FunctionToolPromptOptions,
  PromptUsageAttribution,
  PromptUsageSectionAttribution,
  ReasoningEffort,
} from "../../../../integrations/providers/provider.ts";
import type { TurnLatencyMetricRecorder } from "../../../../operations/metrics/turn-latency.ts";
import { throwIfRuntimeTurnAborted } from "../policy/turn-errors.ts";
import type { NativeTurnRunnerDeps } from "./turn-runner-types.ts";

const PRIVATE_TURN_DECISION_TOOL = "submit_turn_decision";

export type PrivateTurnDecisionValidation =
  | { ok: true; canonicalArgs: Record<string, unknown> }
  | {
    ok: false;
    errorCode: string;
    correction: string;
    canonicalArgs: Record<string, unknown>;
  };

export async function runPrivateTurnDecisionPrompt(input: {
  promptText: string;
  phase: string;
  promptSections?: PromptUsageSectionAttribution[];
  responseFormat?: { schema: Record<string, unknown> };
  validateDecision?: (args: Record<string, unknown>) => PrivateTurnDecisionValidation;
  toolName?: string;
  toolDescription?: string;
  submissionInstruction?: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  systemPrompt: string;
  signal?: AbortSignal;
  attachments: FunctionToolPromptOptions["attachments"];
  butlerData: string;
  toolPromptRunner: NativeTurnRunnerDeps["toolPromptRunner"];
  usageAttribution: (
    phase: string,
    roundIndex: number,
    promptSections?: PromptUsageSectionAttribution[],
  ) => PromptUsageAttribution;
  latencyTracker?: TurnLatencyMetricRecorder;
}): Promise<string> {
  if (!input.responseFormat) throw new Error("turn_contract_response_schema_missing");
  throwIfRuntimeTurnAborted(input.signal);
  let submissionCount = 0;
  let latestValidation: PrivateTurnDecisionValidation | null = null;
  const toolName = input.toolName ?? PRIVATE_TURN_DECISION_TOOL;
  const text = await input.toolPromptRunner({
    prompt: input.promptText,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    instructions: [
      input.systemPrompt,
      input.submissionInstruction ?? `Submit exactly one typed turn decision through ${toolName}.`,
    ].join("\n\n"),
    cacheScope: "session-turn",
    signal: input.signal,
    attachments: input.attachments,
    tools: [{
      type: "function",
      name: toolName,
      description: input.toolDescription ?? "Submit the typed decision that controls this Butler turn.",
      parameters: input.responseFormat.schema,
    }],
    maxToolRounds: 2,
    toolChoice: "required",
    butlerData: input.butlerData,
    usageAttribution: input.usageAttribution(input.phase, 0, input.promptSections),
    executeTool: async (call) => {
      if (call.name !== toolName) {
        throw new Error("turn_contract_decision_tool_mismatch");
      }
      submissionCount += 1;
      latestValidation = input.validateDecision?.(call.args) ?? {
        ok: true,
        canonicalArgs: call.args,
      };
      return latestValidation.ok
        ? { accepted: true }
        : {
          accepted: false,
          error_code: latestValidation.errorCode,
          correction: latestValidation.correction,
        };
    },
    finalTextFromToolResult: ({ name, args }) => {
      if (name !== toolName) return null;
      if (latestValidation?.ok || submissionCount >= 2) {
        return JSON.stringify(latestValidation?.canonicalArgs ?? args);
      }
      return null;
    },
  });
  if (text.trim()) {
    input.latencyTracker?.recordFirstModelDelta({
      phase: input.phase,
      target: "final_candidate",
    });
  }
  return text;
}
