import type {
  ActualModelIdentity,
  ProviderRoundValue,
  SelectedModel,
} from "../../core/index.ts";
import type { AdmittedModelSelection } from "../../contracts.ts";
import type {
  ProductionSelectedModelDependencies,
  ProviderPhasePromptRunner,
} from "./contracts.ts";
import { ModelProviderRequestError } from "../../../../integrations/providers/provider-errors.ts";
import type { OperationalActivation, OperationalDiagnostic } from "../../recovery/index.ts";
import { runWithinModelRoundBoundary } from "./model-round-boundary.ts";
import { createProviderPhasePromptRunner } from "./provider-phase-prompt-runner.ts";
import { renderPhasePrompt } from "./render-phase-prompt.ts";
import { PhasePromptCapacityError } from "./fit-operation-context.ts";
import { providerFailureDiagnostic } from "./provider-failure-diagnostic.ts";
import {
  acceptProviderCarrier,
  ProviderCarrierProtocolError,
} from "./provider-carrier-protocol.ts";

export function createProductionSelectedModel(
  dependencies: ProductionSelectedModelDependencies,
): SelectedModel {
  const promptRunner = dependencies.promptRunner ?? createProviderPhasePromptRunner();
  return {
    async runRound(envelope, signal) {
      const bounded = await runWithinModelRoundBoundary({
        signal,
        totalTimeoutMs: dependencies.roundBoundary?.totalTimeoutMs,
        run: async (roundSignal) => await runSelectedModelRound(
          envelope,
          dependencies,
          promptRunner,
          roundSignal,
        ),
      });
      if (bounded.kind === "timed_out") {
        return interruption("provider_round_timeout", {
          kind: "automatic_provider_recovery",
        });
      }
      if (bounded.kind === "cancelled") {
        return interruption("provider_aborted", { kind: "cancelled" });
      }
      return bounded.value;
    },
  };
}

async function runSelectedModelRound(
  envelope: Parameters<SelectedModel["runRound"]>[0],
  dependencies: ProductionSelectedModelDependencies,
  promptRunner: ProviderPhasePromptRunner,
  signal: AbortSignal,
): Promise<ProviderRoundValue> {
  if (signal.aborted) return interruption("provider_aborted", { kind: "cancelled" });
  try {
    const rendered = await renderProviderPrompt(envelope, dependencies);
    if (signal.aborted) return interruption("provider_aborted", { kind: "cancelled" });
    const result = await promptRunner.run({
      modelSelection: envelope.modelSelection,
      instructions: rendered.instructions,
      prompt: rendered.prompt,
      promptCacheBoundary: rendered.promptCacheBoundary,
      responseSchema: rendered.responseSchema,
      carrierFunctions: rendered.carrierFunctions,
      cacheScope: `btcc:${envelope.phase}`,
      usageAttribution: {
        turnId: envelope.binding.turnId,
        phase: envelope.phase,
      },
      signal,
    });
    if (!sameIdentity(envelope.modelSelection, result.actualIdentity)) {
      return interruption("selected_model_identity_mismatch", {
        kind: "runtime_remediation",
      });
    }
    try {
      return acceptProviderCarrier(result.carrier, {
        responseSchema: rendered.carrierAdmissionSchema,
        authority: envelope.operationAuthority,
        actualIdentity: result.actualIdentity,
      });
    } catch (error) {
      if (error instanceof ProviderCarrierProtocolError) {
        reportProviderCarrierRejection(envelope, error);
        return interruption("provider_protocol_interruption", {
          kind: envelope.providerCorrection
            ? "runtime_remediation"
            : "automatic_provider_recovery",
        }, undefined, error.diagnostic);
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
    if (signal.aborted || isAbortError(error)) {
      return interruption("provider_aborted", { kind: "cancelled" });
    }
    if (error instanceof ModelProviderRequestError) {
      return interruption(
        error.code,
        activationForProviderFailure(error),
        undefined,
        providerFailureDiagnostic(error),
      );
    }
    if (error instanceof PhasePromptRenderError) {
      const cause = error.cause;
      return cause instanceof PhasePromptCapacityError
        ? interruption(
            "phase_prompt_capacity_exceeded",
            { kind: "runtime_remediation" },
            cause.message,
          )
        : interruption("phase_prompt_render_interruption", {
            kind: "runtime_remediation",
          });
    }
    return interruption("provider_adapter_interruption", {
      kind: "automatic_provider_recovery",
    });
  }
}

function reportProviderCarrierRejection(
  envelope: Parameters<SelectedModel["runRound"]>[0],
  error: ProviderCarrierProtocolError,
): void {
  console.error(JSON.stringify({
    event: "btcc_provider_carrier_rejected",
    turnId: envelope.binding.turnId,
    phase: envelope.phase,
    checkpointId: envelope.binding.checkpointId,
    diagnostic: error.diagnostic,
  }));
}

class PhasePromptRenderError extends Error {
  override readonly name = "PhasePromptRenderError";
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
  diagnostic?: OperationalDiagnostic,
): ProviderRoundValue {
  return {
    kind: "interruption",
    code,
    activation,
    ...(diagnosticMessage ? { diagnosticMessage } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function activationForProviderFailure(
  error: ModelProviderRequestError,
): OperationalActivation {
  if (error.statusCode === 429) {
    return error.retryAt
      ? { kind: "automatic_provider_recovery", retryAt: error.retryAt }
      : { kind: "provider_action_required" };
  }
  if (error.statusCode !== undefined && error.statusCode >= 500) {
    return {
      kind: "automatic_provider_recovery",
      ...(error.retryAt ? { retryAt: error.retryAt } : {}),
    };
  }
  if (
    error.code === "provider_network_error" ||
    error.code === "provider_transport_interruption" ||
    error.code === "provider_empty_response" ||
    error.code === "provider_round_timeout"
  ) {
    return { kind: "automatic_provider_recovery" };
  }
  if (
    error.code === "provider_context_limit_exceeded"
  ) {
    return { kind: "runtime_remediation" };
  }
  if (
    error.code === "provider_auth_error" ||
    error.statusCode === 400 ||
    error.statusCode === 401 ||
    error.statusCode === 403
  ) {
    return { kind: "provider_action_required" };
  }
  return { kind: "runtime_remediation" };
}
