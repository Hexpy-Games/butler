import { contentRef, type ObservationResult, type PhaseEnvelope }
  from "../../core/index.ts";
import type { ProductionOperationRuntimeOptions } from "./contracts.ts";
import { assertActive, operationContent } from "./operation-helpers.ts";

export async function performTurnLocalEffect(input: {
  request: Extract<import("../../core/index.ts").OperationRequest, {
    kind: "turn_local_effect";
  }>;
  envelope: PhaseEnvelope;
  options: ProductionOperationRuntimeOptions;
  signal?: AbortSignal;
}): Promise<ObservationResult> {
  assertActive(input.signal);
  input.options.validateOperationInput({
    envelope: input.envelope,
    request: input.request,
    args: input.request.input,
  });
  const execute = input.options.createTurnLocalEffectExecutor({
    envelope: input.envelope,
    request: input.request,
  });
  const output = await execute({
    name: input.request.capabilityRef,
    args: input.request.input,
    rawArguments: JSON.stringify(input.request.input),
    signal: input.signal,
  });
  assertActive(input.signal);
  const payload = operationContent(output);
  return {
    requestId: input.request.requestId,
    outcome: "turn_local_effect_applied",
    observationRef: contentRef("turn-local-effect", {
      requestId: input.request.requestId,
      capabilityRef: input.request.capabilityRef,
      output,
    }),
    content: payload.content,
    ...(payload.payloadSource ? { payloadSource: payload.payloadSource } : {}),
  };
}
