import { contentRef, stableJson, type ObservationResult, type PhaseEnvelope }
  from "../../core/index.ts";
import type { ProductionOperationRuntimeOptions } from "./contracts.ts";
import { assertActive, operationContent } from "./operation-helpers.ts";

export async function performExternalEffect(input: {
  request: Extract<import("../../core/index.ts").OperationRequest, { kind: "external_effect" }>;
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
  const execute = input.options.createExternalEffectExecutor({
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
  const targetSnapshotRef = contentRef("external-target-snapshot", {
    targetScopeRef: input.request.targetScopeRef,
    output: stableJson(output),
  });
  const effectReceiptRef = contentRef("external-effect-receipt", {
    effectIntentRef: input.request.effectIntentRef,
    occurrenceKey: input.request.occurrenceKey,
    requestId: input.request.requestId,
    targetScopeRef: input.request.targetScopeRef,
    targetSnapshotRef,
  });
  return {
    requestId: input.request.requestId,
    outcome: "external_effect_applied",
    observationRef: contentRef("external-effect-observation", {
      effectReceiptRef,
      targetSnapshotRef,
    }),
    effectReceiptRef,
    targetSnapshotRef,
    content: payload.content,
    ...(payload.payloadSource ? { payloadSource: payload.payloadSource } : {}),
  };
}
