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
import { validateJsonObjectSchema } from "../../../tools/tool-bridge/schema-validation.ts";

export function createProductionSelectedModel(
  dependencies: ProductionSelectedModelDependencies,
): SelectedModel {
  const promptRunner = dependencies.promptRunner ?? createProviderPhasePromptRunner();
  return {
    async runRound(envelope, signal) {
      if (signal?.aborted) return interruption("provider_aborted", { kind: "cancelled" });
      try {
        const rendered = await renderProviderPrompt(envelope, dependencies);
        if (signal?.aborted) return interruption("provider_aborted", { kind: "cancelled" });
        const { admissionSchema, ...providerPrompt } = rendered;
        const result = await promptRunner.run({
          modelSelection: envelope.modelSelection,
          ...providerPrompt,
          cacheScope: `btcc:${envelope.phase}`,
          signal,
        });
        if (!sameIdentity(envelope.modelSelection, result.actualIdentity)) {
          return interruption("selected_model_identity_mismatch", {
            kind: "runtime_remediation",
          });
        }
        try {
          assertCarrierMatchesRenderedSchema(result.carrier, admissionSchema);
          return decodeCarrier(
            result.carrier,
            envelope.operationAuthority,
            result.actualIdentity,
          );
        } catch (error) {
          if (error instanceof ProviderCarrierProtocolError) {
            return interruption("provider_protocol_interruption", {
              kind: "automatic_provider_recovery",
            }, error.message);
          }
          throw error;
        }
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
        if (error instanceof PhasePromptRenderError) {
          return interruption("phase_prompt_render_interruption", {
            kind: "runtime_remediation",
          });
        }
        return interruption("provider_adapter_interruption", {
          kind: "automatic_provider_recovery",
        });
      }
    },
  };
}

function assertCarrierMatchesRenderedSchema(
  carrier: unknown,
  responseSchema: Record<string, unknown>,
): asserts carrier is Record<string, unknown> {
  if (!isRecord(carrier)) {
    throw new ProviderCarrierProtocolError("BTCC provider carrier is not an object");
  }
  const validation = validateJsonObjectSchema(carrier, responseSchema);
  if (!validation.ok) {
    throw new ProviderCarrierProtocolError(
      `BTCC provider carrier violates the rendered schema at ${validation.path}`,
    );
  }
}

function decodeCarrier(
  carrier: unknown,
  authority: OperationAuthority,
  actualIdentity: ActualModelIdentity,
): ProviderRoundValue {
  if (!isRecord(carrier)) {
    throw new ProviderCarrierProtocolError("BTCC provider carrier is not an object");
  }
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
  throw new ProviderCarrierProtocolError("BTCC provider carrier violates the closed protocol");
}

class ProviderCarrierProtocolError extends Error {
  override readonly name = "ProviderCarrierProtocolError";
}

class PhasePromptRenderError extends Error {
  override readonly name = "PhasePromptRenderError";
}

function bindOperationAuthority(
  value: Record<string, unknown>,
  authority: OperationAuthority,
): OperationRequest {
  if (value.kind === "observe") return value as OperationRequest;
  if (
    value.kind === "workspace_artifact_observation" &&
    authority.mutation.kind === "workspace_only"
  ) {
    return { ...value, workspaceRef: authority.mutation.workspaceRef } as OperationRequest;
  }
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
  throw new ProviderCarrierProtocolError(
    "BTCC provider requested an operation without matching runtime authority",
  );
}

async function renderProviderPrompt(
  envelope: Parameters<SelectedModel["runRound"]>[0],
  dependencies: ProductionSelectedModelDependencies,
) {
  try {
    return await renderPhasePrompt(
      envelope,
      dependencies.context,
      dependencies.capabilities,
      dependencies.guidance,
    );
  } catch (error) {
    throw new PhasePromptRenderError("BTCC phase prompt rendering failed", { cause: error });
  }
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
  diagnosticMessage?: string,
): ProviderRoundValue {
  return {
    kind: "interruption",
    code,
    activation,
    ...(diagnosticMessage ? { diagnosticMessage } : {}),
  };
}

function activationForProviderFailure(
  error: ModelProviderRequestError,
): OperationalActivation {
  if (
    error.code === "provider_network_error" ||
    error.code === "provider_transport_interruption" ||
    error.code === "provider_empty_response" ||
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
