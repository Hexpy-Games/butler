import type {
  ActualModelIdentity,
  OperationRequest,
  ProviderRoundValue,
  SelectedModel,
} from "../../core/index.ts";
import type { AdmittedModelSelection } from "../../contracts.ts";
import type { ProductionSelectedModelDependencies } from "./contracts.ts";
import { ModelProviderRequestError } from "../../../../integrations/providers/provider-errors.ts";
import { createProviderPhasePromptRunner } from "./provider-phase-prompt-runner.ts";
import { renderPhasePrompt } from "./render-phase-prompt.ts";

export function createProductionSelectedModel(
  dependencies: ProductionSelectedModelDependencies,
): SelectedModel {
  const promptRunner = dependencies.promptRunner ?? createProviderPhasePromptRunner();
  return {
    async runRound(envelope, signal) {
      if (signal?.aborted) return interruption("provider_aborted");
      try {
        const rendered = await renderPhasePrompt(
          envelope,
          dependencies.context,
          dependencies.capabilities,
        );
        if (signal?.aborted) return interruption("provider_aborted");
        const result = await promptRunner.run({
          modelSelection: envelope.modelSelection,
          ...rendered,
          cacheScope: `btcc:${envelope.phase}`,
          signal,
        });
        if (!sameIdentity(envelope.modelSelection, result.actualIdentity)) {
          throw new Error("BTCC provider returned a different selected-model identity");
        }
        return decodeCarrier(result.carrier, result.actualIdentity);
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) return interruption("provider_aborted");
        if (error instanceof ModelProviderRequestError) return interruption(error.code);
        throw error;
      }
    },
  };
}

function decodeCarrier(
  carrier: unknown,
  actualIdentity: ActualModelIdentity,
): ProviderRoundValue {
  if (!isRecord(carrier)) throw new Error("BTCC provider carrier is not an object");
  if (carrier.kind === "phase_submission" && isRecord(carrier.submission)) {
    return {
      kind: "phase_submission",
      submission: carrier.submission,
      actualIdentity,
    };
  }
  if (
    carrier.kind === "operation_requests" &&
    Array.isArray(carrier.requests) &&
    carrier.requests.length > 0 &&
    carrier.requests.every(isRecord)
  ) {
    return {
      kind: "operation_requests",
      requests: carrier.requests as OperationRequest[],
      actualIdentity,
    };
  }
  throw new Error("BTCC provider carrier violates the closed protocol");
}

function sameIdentity(
  expected: AdmittedModelSelection,
  actual: ActualModelIdentity,
): boolean {
  return actual.provider === expected.provider &&
    actual.model === expected.model &&
    actual.reasoningEffort === expected.reasoningEffort &&
    actual.controlsHash === expected.controlsHash;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function interruption(code: string): ProviderRoundValue {
  return { kind: "interruption", code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
