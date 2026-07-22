import type {
  ActualModelIdentity,
  OperationAuthority,
  OperationRequest,
  ProviderRoundValue,
  SelectedModel,
} from "../../core/index.ts";
import type { AdmittedModelSelection } from "../../contracts.ts";
import type { ProductionSelectedModelDependencies } from "./contracts.ts";
import { ModelProviderRequestError } from "../../../../integrations/providers/provider-errors.ts";
import type { OperationalActivation } from "../../recovery/index.ts";
import { createProviderPhasePromptRunner } from "./provider-phase-prompt-runner.ts";
import { renderPhasePrompt } from "./render-phase-prompt.ts";

export function createProductionSelectedModel(
  dependencies: ProductionSelectedModelDependencies,
): SelectedModel {
  const promptRunner = dependencies.promptRunner ?? createProviderPhasePromptRunner();
  return {
    async runRound(envelope, signal) {
      if (signal?.aborted) return interruption("provider_aborted", { kind: "cancelled" });
      try {
        const rendered = await renderPhasePrompt(
          envelope,
          dependencies.context,
          dependencies.capabilities,
          dependencies.guidance,
        );
        if (signal?.aborted) return interruption("provider_aborted", { kind: "cancelled" });
        const result = await promptRunner.run({
          modelSelection: envelope.modelSelection,
          ...rendered,
          cacheScope: `btcc:${envelope.phase}`,
          signal,
        });
        if (!sameIdentity(envelope.modelSelection, result.actualIdentity)) {
          throw new Error("BTCC provider returned a different selected-model identity");
        }
        return decodeCarrier(
          result.carrier,
          envelope.operationAuthority,
          result.actualIdentity,
        );
      } catch (error) {
        if (process.env.BUTLER_OPERATIONAL_DIAGNOSTICS === "1") {
          const diagnostic = error instanceof ModelProviderRequestError
            ? error.diagnostic()
            : {
                name: error instanceof Error ? error.name : "UnknownError",
                message: error instanceof Error ? error.message : String(error),
              };
          console.error(JSON.stringify({
            event: "btcc_provider_round_interruption",
            phase: envelope.phase,
            diagnostic,
          }));
        }
        if (signal?.aborted || isAbortError(error)) {
          return interruption("provider_aborted", { kind: "cancelled" });
        }
        if (error instanceof ModelProviderRequestError) {
          return interruption(error.code, activationForProviderFailure(error));
        }
        return interruption("provider_protocol_interruption", {
          kind: "runtime_remediation",
        });
      }
    },
  };
}

function decodeCarrier(
  carrier: unknown,
  authority: OperationAuthority,
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
      requests: carrier.requests.map((request) => bindOperationAuthority(request, authority)),
      actualIdentity,
    };
  }
  throw new Error("BTCC provider carrier violates the closed protocol");
}

function bindOperationAuthority(
  value: Record<string, unknown>,
  authority: OperationAuthority,
): OperationRequest {
  if (value.kind === "observe") return value as OperationRequest;
  if (value.kind === "workspace_artifact_action" && authority.mutation.kind === "workspace_only") {
    return { ...value, workspaceRef: authority.mutation.workspaceRef } as OperationRequest;
  }
  if (value.kind === "review_validation" &&
    authority.mutation.kind === "validation_overlay_only"
  ) {
    return { ...value, reviewSourceRef: authority.mutation.reviewSourceRef } as OperationRequest;
  }
  if (value.kind === "repository_promotion" &&
    authority.mutation.kind === "repository_promotion_only"
  ) {
    return {
      ...value,
      authorizationRef: authority.mutation.authorizationRef,
      candidateRef: authority.mutation.candidateRef,
      resolutionRef: authority.mutation.resolutionRef,
      baselineRef: authority.mutation.baselineRef,
      finalSnapshotRef: authority.mutation.finalSnapshotRef,
    } as OperationRequest;
  }
  throw new Error("BTCC provider requested an operation without matching runtime authority");
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

function interruption(
  code: string,
  activation: OperationalActivation,
): ProviderRoundValue {
  return { kind: "interruption", code, activation };
}

function activationForProviderFailure(
  error: ModelProviderRequestError,
): OperationalActivation {
  if (
    error.code === "provider_network_error" ||
    error.code === "provider_transport_interruption" ||
    error.code === "provider_round_timeout" ||
    error.statusCode === 429 ||
    (error.statusCode !== undefined && error.statusCode >= 500)
  ) {
    return { kind: "automatic_provider_recovery" };
  }
  if (
    error.code === "provider_auth_error" ||
    error.code === "provider_context_limit_exceeded" ||
    error.statusCode === 400 ||
    error.statusCode === 401 ||
    error.statusCode === 403
  ) {
    return { kind: "provider_action_required" };
  }
  return { kind: "runtime_remediation" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
