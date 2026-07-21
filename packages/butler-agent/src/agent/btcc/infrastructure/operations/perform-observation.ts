import { contentRef, type ObservationResult, type PhaseEnvelope } from "../../core/index.ts";
import type { ProductionOperationRuntimeOptions } from "./contracts.ts";
import { assertActive, operationContent } from "./operation-helpers.ts";

export async function performObservation(input: {
  request: Extract<import("../../core/index.ts").OperationRequest, { kind: "observe" }>;
  envelope: PhaseEnvelope;
  options: ProductionOperationRuntimeOptions;
  signal?: AbortSignal;
}): Promise<ObservationResult> {
  assertActive(input.signal);
  const args = input.request.input;
  input.options.validateOperationInput({
    envelope: input.envelope,
    request: input.request,
    args,
  });
  const execute = input.options.createToolExecutor({
    envelope: input.envelope,
    request: input.request,
  });
  const output = await execute({
    name: input.request.capabilityRef,
    args,
    rawArguments: JSON.stringify(input.request.input),
    signal: input.signal,
  });
  assertActive(input.signal);
  const content = operationContent(output);
  return {
    requestId: input.request.requestId,
    outcome: "observed",
    observationRef: contentRef("external-observation", {
      requestId: input.request.requestId,
      capabilityRef: input.request.capabilityRef,
      scopeRef: input.request.scopeRef,
      content,
    }),
    content,
  };
}
