import type { PhaseEnvelope } from "../../core/index.ts";
import type { AcceptedPhaseGuidance } from "../../guidance/index.ts";
import type { AvailablePhaseCapability, ResolvedContextDocument } from "./contracts.ts";
import { loadBasePrompt } from "./base-phase-prompts.ts";
import {
  resolveDutyInstructions,
  resolveProhibitionInstructions,
} from "./prompt-duty-catalog.ts";
import {
  promptOperationContext,
  type ProjectedOperationContext,
} from "./project-operation-context.ts";
import { projectContinuationContext } from "./project-continuation-context.ts";
import type { PromptCacheBoundary } from "../../../../integrations/providers/contracts.ts";

const DOCUMENT_BOUNDARY = "\n";

export function renderCacheOrderedPhasePrompt(input: {
  envelope: PhaseEnvelope;
  resolvedContext: {
    profile: ResolvedContextDocument[];
    recentFeedback: ResolvedContextDocument[];
    mandatoryHotCache: ResolvedContextDocument[];
    optionalHotCache: ResolvedContextDocument[];
  };
  availableCapabilities: AvailablePhaseCapability[];
  acceptedPhaseGuidance: AcceptedPhaseGuidance[];
  operationContext: ProjectedOperationContext;
}): { prompt: string; promptCacheBoundary: PromptCacheBoundary } {
  const stablePrefix = canonicalJson(stablePhasePrefix(input)) + DOCUMENT_BOUNDARY;
  const dynamicSuffix = canonicalJson(dynamicTurnContent(input));
  return {
    prompt: stablePrefix + dynamicSuffix,
    promptCacheBoundary: { stablePrefix, dynamicSuffix },
  };
}

function stablePhasePrefix(input: Parameters<typeof renderCacheOrderedPhasePrompt>[0]) {
  return {
    stablePhasePrefix: {
      promptHierarchy: [
        {
          layer: "immutablePhaseContract",
          content: immutablePhaseContract(input.envelope),
        },
        {
          layer: "versionedBasePrompt",
          content: loadBasePrompt(input.envelope.phase),
        },
        {
          layer: "acceptedPhaseGuidance",
          content: sortedGuidance(input.acceptedPhaseGuidance),
        },
      ],
      carrierProtocol: carrierProtocolGuidance(
        input.envelope.operationSurface !== "closed",
      ),
    },
  };
}

function dynamicTurnContent(input: Parameters<typeof renderCacheOrderedPhasePrompt>[0]) {
  const { envelope, resolvedContext } = input;
  return {
    dynamicTurnContent: {
      binding: envelope.binding,
      selectedModel: envelope.modelSelection,
      currentAcceptedState: {
        stateInput: envelope.context.stateInput ?? null,
        authoringContractRefs: envelope.authoringContractRefs ?? [],
        authoringContracts: envelope.authoringContracts ?? [],
      },
      originalRequest: {
        messageId: envelope.context.originalMessageId,
        content: envelope.context.originalMessage,
      },
      butlerContext: {
        sessionId: envelope.context.sessionId,
        userRef: envelope.context.userRef,
        projectRef: envelope.context.projectRef ?? null,
        profile: resolvedContext.profile,
        recentFeedback: resolvedContext.recentFeedback,
        mandatoryHotCache: resolvedContext.mandatoryHotCache,
        optionalHotCache: resolvedContext.optionalHotCache,
        continuation: projectContinuationContext(envelope),
        baselineObservationScopeRefs: envelope.context.baselineObservationScopeRefs,
      },
      operationContext: promptOperationContext(input.operationContext),
      capabilitySchemas: input.availableCapabilities,
      availableCarrierKinds: envelope.operationSurface !== "closed" &&
          input.availableCapabilities.length > 0
        ? ["phase_submission", "operation_requests"]
        : ["phase_submission"],
      providerCorrection: envelope.providerCorrection ?? null,
      providerCorrectionInstruction: envelope.providerCorrection
        ? providerCorrectionInstruction(envelope.providerCorrection)
        : null,
    },
  };
}

function immutablePhaseContract(envelope: PhaseEnvelope) {
  return {
    phase: envelope.phase,
    operationSurface: envelope.operationSurface,
    objective: envelope.objective,
    duties: resolveDutyInstructions(envelope.duties),
    prohibitions: resolveProhibitionInstructions(envelope.prohibitions),
    ...(envelope.exitDuties
      ? {
          exitDuties: Object.fromEntries(Object.entries(envelope.exitDuties)
            .map(([exit, duties]) => [exit, resolveDutyInstructions(duties)])),
        }
      : {}),
  };
}

function sortedGuidance(guidance: AcceptedPhaseGuidance[]): AcceptedPhaseGuidance[] {
  return [...guidance].sort((left, right) =>
    left.guidanceId.localeCompare(right.guidanceId) ||
    left.revision - right.revision ||
    left.contentSha256.localeCompare(right.contentSha256),
  );
}

function carrierProtocolGuidance(allowsOperations: boolean) {
  return {
    phaseSubmission: [
      "Use one submission object allowed by the exact phase exits.",
      "Write publicActivity as a user-visible handoff: title is a concrete display label normally around 20 characters and never over 32 Unicode characters; summary names the complete target and decision or result; rationale explains why it matters; nextStep names the next observable action or transition.",
      "Do not substitute a generic phase label for useful activity detail.",
      "Do not expose hidden chain-of-thought or copy raw operation output.",
    ].join(" "),
    ...(allowsOperations
      ? {
          operationRequests: [
            "Apply these instructions only when operation_requests appears in availableCarrierKinds.",
            "Use a non-empty array containing only operation-kind and capability pairs listed in capabilitySchemas.",
            "For observe, select the required scopeRef from that capability's observationScopeRefs; runtime binds the authority identities for mutation operations.",
            "Write each request publicTitle as a concise user-visible action title; describe the concrete action without copying commands, arguments, or hidden reasoning.",
            "Include every currently known independent operation needed for the next decision in this one batch; keep only genuinely result-dependent work for a later round.",
            "Rewrite phaseContinuity to preserve integrated decisions and the purpose of this batch.",
            "Write publicActivity for the user: title is a concrete display label normally around 20 characters and never over 32 Unicode characters; summary names the complete target and current action; rationale explains why it is needed; nextStep names what observable action follows.",
            "Do not substitute a generic phase label for useful activity detail or expose hidden chain-of-thought.",
            "Do not copy raw operation output into phaseContinuity; durable results remain readable by ref.",
            "Consume every inlineOperationResults item whose inlinePayload.kind is complete directly; it is the entire requested result and must not be read again through read_operation_result.",
            "For inlinePayload.kind partial, call read_operation_result only when omitted content is necessary for the next semantic decision.",
            "Use each priorOperationResultIndex source descriptor to find a compacted stable result, then read_operation_result instead of repeating its source operation. Repeat the source only for a fresh target revision or an uncaptured view.",
            "Use a result executionSummary to determine command exit success. Read omitted command payload only when its content is necessary for failure diagnosis or the next semantic decision.",
          ].join(" "),
        }
      : {}),
  };
}

function providerCorrectionInstruction(
  correction: NonNullable<PhaseEnvelope["providerCorrection"]>,
): string {
  const diagnostic = providerCorrectionDiagnostic(correction);
  return "The previous provider product was rejected before semantic acceptance." +
    diagnostic +
    " Correct it against the exact current schema and capability list; do not repeat the rejected shape.";
}

function providerCorrectionDiagnostic(
  correction: NonNullable<PhaseEnvelope["providerCorrection"]>,
): string {
  if (correction.diagnostic?.kind === "provider_carrier_rejection") {
    return ` The carrier was rejected at ${correction.diagnostic.path} ` +
      `for ${correction.diagnostic.reason}.`;
  }
  return correction.diagnosticMessage
    ? ` Rejection reason: ${correction.diagnosticMessage}.`
    : "";
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}
