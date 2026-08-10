import type {
  BtccAgentLoopEvent,
  BtccAgentLoopInput,
} from "./contracts.ts";
import type {
  PromptUsageAttribution,
  ReasoningEffort,
} from "../../../integrations/providers/runtime-contracts.ts";
import {
  createM1BaselineObservationRecorder,
  type M1BaselineObservationStatus,
} from "../../../operations/metrics/m1-baseline-observation.ts";

export function createGuidedTurnBaselineObservation(input: {
  butlerData: string;
  modelRef: string;
  reasoning: ReasoningEffort;
  startedAtMs?: number;
  resolveModelRef: () => string;
}) {
  const recorder = createM1BaselineObservationRecorder({
    butlerData: input.butlerData,
    startedAtMs: input.startedAtMs,
    metadata: {
      modelRef: input.modelRef,
      reasoning: input.reasoning,
    },
  });
  let terminalStatus: M1BaselineObservationStatus | null = null;

  const usageAttribution: Pick<PromptUsageAttribution,
    "beforeModelRequest" | "beforeAdmittedModelRequest" | "afterModelResponseUsage"> = {
    beforeModelRequest: () => recorder.observeModelRequest(),
    beforeAdmittedModelRequest: ({ admittedPromptTokens }) =>
      recorder.observeSerializedInputEstimate(admittedPromptTokens, input.resolveModelRef()),
    afterModelResponseUsage: (usage) => recorder.observeProviderUsage(usage),
  };

  const onEvent: NonNullable<BtccAgentLoopInput["onEvent"]> = (event: BtccAgentLoopEvent) => {
    if (event.type === "model_response" && event.text?.trim()) {
      recorder.observeFirstUseful();
    }
    if (event.type === "tool_call") {
      recorder.observeToolCall();
      recorder.observeFirstUseful();
    }
    if (event.type === "tool_result" && event.toolResult) {
      recorder.observeToolResult(event.toolResult.ok);
    }
  };

  return {
    usageAttribution,
    onEvent,
    markMeasurementIneligible(): void {
      recorder.markMeasurementIneligible();
    },
    markSuccess(): void {
      terminalStatus = recorder.metadata.armState === "accepted" ? "ok" : "skipped";
    },
    finalize(fallbackStatus: M1BaselineObservationStatus): void {
      recorder.finalize(terminalStatus ?? fallbackStatus);
    },
  };
}
