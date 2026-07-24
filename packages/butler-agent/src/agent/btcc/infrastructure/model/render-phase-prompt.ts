import type { PhaseEnvelope } from "../../core/index.ts";
import { modelStructuredDecisionTransport } from
  "../../../../integrations/providers/model-catalog.ts";
import type {
  ButlerContextResolver,
  RenderedPhasePrompt,
  ResolvedContextDocument,
  StructuralCapabilityCatalog,
} from "./contracts.ts";
import { resolveAvailableCapabilities } from "./available-capabilities.ts";
import { providerCarrierSchema } from "./provider-carrier-schema.ts";
import { providerCarrierFunctions } from "./provider-carrier-schema.ts";
import { providerCarrierAdmissionSchema } from "./provider-carrier-schema.ts";
import type { PhaseGuidanceReader } from "../../guidance/index.ts";
import { loadBasePrompt } from "./base-phase-prompts.ts";
import {
  resolveDutyInstructions,
  resolveProhibitionInstructions,
} from "./prompt-duty-catalog.ts";
import { projectOperationContext } from "./project-operation-context.ts";
import { projectContinuationContext } from "./project-continuation-context.ts";
import { fitOperationContext } from "./fit-operation-context.ts";

export async function renderPhasePrompt(
  envelope: PhaseEnvelope,
  contextResolver: ButlerContextResolver,
  capabilityCatalog: StructuralCapabilityCatalog,
  guidanceReader: PhaseGuidanceReader,
): Promise<RenderedPhasePrompt> {
  const operationAuthority = envelope.operationSurface === "closed"
    ? {
        observationScopeRefs: [],
        mutation: { kind: "forbidden" as const },
      }
    : envelope.operationAuthority;
  const [resolvedContext, availableCapabilities, acceptedPhaseGuidance] = await Promise.all([
    resolveButlerContext(envelope, contextResolver),
    resolveAvailableCapabilities({
      authority: operationAuthority,
      catalog: capabilityCatalog,
    }),
    guidanceReader.list({
      phase: envelope.phase,
      userRef: envelope.context.userRef,
      ...(envelope.context.projectRef ? { projectRef: envelope.context.projectRef } : {}),
    }),
  ]);
  const responseSchema = providerCarrierSchema(
    availableCapabilities,
    envelope.submissionSchema,
    operationAuthority,
  );
  const carrierFunctions = providerCarrierFunctions(
    availableCapabilities,
    envelope.submissionSchema,
    operationAuthority,
  );
  const instructions = [
    "Return exactly one BTCC provider carrier matching the supplied JSON schema.",
    "Do not add prose outside the carrier and do not choose a successor phase or model.",
    "Choose semantic operations only; the runtime binds immutable authority references.",
    ...(envelope.providerCorrection
      ? [providerCorrectionInstruction(envelope.providerCorrection)]
      : []),
    "Follow promptHierarchy in order: earlier layers override later layers.",
  ].join(" ");
  const projectedOperationContext = projectOperationContext(envelope);
  const renderPrompt = (
    operationContext: typeof projectedOperationContext,
  ) => JSON.stringify(promptDocument({
    envelope,
    resolvedContext,
    availableCapabilities,
    acceptedPhaseGuidance,
    operationAuthority,
    operationContext,
  }));
  const operationContext = fitOperationContext({
    projected: projectedOperationContext,
    modelSelection: envelope.modelSelection,
    renderPrompt,
    fixedRequestShape: fixedProviderRequestShape(
      envelope,
      instructions,
      responseSchema,
      carrierFunctions,
    ),
  });
  return {
    instructions,
    prompt: renderPrompt(operationContext),
    responseSchema,
    carrierFunctions,
    admissionSchema: providerCarrierAdmissionSchema(
      availableCapabilities,
      envelope.submissionSchema,
    ),
  };
}

function fixedProviderRequestShape(
  envelope: PhaseEnvelope,
  instructions: string,
  responseSchema: Record<string, unknown>,
  carrierFunctions: ReturnType<typeof providerCarrierFunctions>,
) {
  const selected = envelope.modelSelection;
  const modelRef = selected.model.includes("/")
    ? selected.model
    : `${selected.provider}/${selected.model}`;
  return modelStructuredDecisionTransport(modelRef) === "function_tool"
    ? { instructions, carrierFunctions }
    : { instructions, responseSchema };
}

function promptDocument(input: {
  envelope: PhaseEnvelope;
  resolvedContext: Awaited<ReturnType<typeof resolveButlerContext>>;
  availableCapabilities: Awaited<ReturnType<typeof resolveAvailableCapabilities>>;
  acceptedPhaseGuidance: Awaited<ReturnType<PhaseGuidanceReader["list"]>>;
  operationAuthority: PhaseEnvelope["operationAuthority"];
  operationContext: ReturnType<typeof projectOperationContext>;
}) {
  const {
    envelope,
    resolvedContext,
    availableCapabilities,
    acceptedPhaseGuidance,
    operationAuthority,
    operationContext,
  } = input;
  return {
      binding: envelope.binding,
      selectedModel: envelope.modelSelection,
      promptHierarchy: {
        immutablePhaseContract: exactPhaseContract(envelope),
        versionedBasePrompt: loadBasePrompt(envelope.phase),
        acceptedPhaseGuidance,
        currentTurnContext: {
          stateInput: envelope.context.stateInput ?? null,
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
          operationContext,
          operationAuthority,
          availableCapabilities,
          providerCorrection: envelope.providerCorrection ?? null,
        },
      },
      outputSchemaGuidance: {
        carrierKinds: availableCapabilities.length > 0
          ? ["phase_submission", "operation_requests"]
          : ["phase_submission"],
        phaseSubmission: [
          "Use one submission object allowed by the exact phase exits.",
          "Write publicActivity as a concise user-visible handoff: what this phase decided, why it matters, and what the next phase will do.",
          "Do not expose hidden chain-of-thought or copy raw operation output.",
        ].join(" "),
        ...(availableCapabilities.length > 0
          ? {
              operationRequests: [
                "Use a non-empty array of typed requests within authority.",
                "Include every currently known independent operation needed for the next decision in this one batch; keep only genuinely result-dependent work for a later round.",
                "Rewrite phaseContinuity to preserve integrated decisions and the purpose of this batch.",
                "Write publicActivity for the user: what is happening, why it is needed, and what follows; summarize intent without hidden chain-of-thought.",
                "Do not copy raw operation output into phaseContinuity; durable results remain readable by ref.",
                "Use each priorOperationResultIndex source descriptor to find the exact stable result, then read_operation_result instead of repeating its source operation. Repeat the source only for a fresh target revision or an uncaptured view.",
                "Use a result executionSummary to determine command exit success. Read omitted command payload only when its content is necessary for failure diagnosis or the next semantic decision.",
              ].join(" "),
            }
          : {}),
      },
  };
}

function providerCorrectionInstruction(
  correction: NonNullable<PhaseEnvelope["providerCorrection"]>,
): string {
  const diagnostic = correction.diagnosticMessage
    ? ` Rejection reason: ${correction.diagnosticMessage}.`
    : "";
  return "The previous provider product was rejected before semantic acceptance." +
    diagnostic +
    " Correct it against the exact current schema and capability list; do not repeat the rejected shape.";
}

function exactPhaseContract(envelope: PhaseEnvelope) {
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
    ...(envelope.authoringContractRefs
      ? { authoringContractRefs: envelope.authoringContractRefs }
      : {}),
    ...(envelope.authoringContracts
      ? { authoringContracts: envelope.authoringContracts }
      : {}),
  };
}

async function resolveButlerContext(
  envelope: PhaseEnvelope,
  resolver: ButlerContextResolver,
) {
  return {
    profile: await resolveDocuments(envelope.context.profileRefs, resolver),
    recentFeedback: await resolveDocuments(envelope.context.recentFeedbackRefs, resolver),
    mandatoryHotCache: await resolveDocuments(envelope.context.mandatoryHotCacheRefs, resolver),
    optionalHotCache: await resolveDocuments(envelope.context.optionalHotCacheRefs, resolver),
  };
}

async function resolveDocuments(
  refs: readonly string[],
  resolver: ButlerContextResolver,
): Promise<ResolvedContextDocument[]> {
  return await Promise.all(refs.map(async (ref) => ({
    ref,
    content: await resolver.resolve(ref),
  })));
}
